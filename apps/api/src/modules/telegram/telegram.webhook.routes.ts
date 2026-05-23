/**
 * Telegram Bot webhook receiver + admin setup endpoint.
 *
 * Flow:
 *   1. User clicks deep-link `https://t.me/<bot>?start=<code>`
 *   2. Telegram client sends `/start <code>` to the bot
 *   3. Telegram backend POSTs an Update object to our webhook URL
 *      (registered once via the admin endpoint below)
 *   4. We parse `/start <code>`, call `completeLink()`, and reply in
 *      the same chat with a confirmation message.
 *
 * Security: Telegram includes the configured `secret_token` in the
 * `X-Telegram-Bot-Api-Secret-Token` header. We compute a deterministic
 * secret from the bot API token (sha256 → first 32 chars) so rotating
 * the token rotates the webhook secret automatically. The webhook URL
 * is mounted without auth/CSRF; the header is the only gate.
 */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { fetch as undiciFetch } from "undici";
import { z } from "zod";

import { UnauthorizedError } from "../../core/errors.js";

import type { TelegramService } from "./telegram.service.js";
import type { TelegramProxyState } from "./telegram.proxy.js";

/**
 * Deterministic 32-char hex secret derived from the bot API token.
 * Empty string when token isn't configured — webhook handler will
 * reject all requests in that state.
 */
export function deriveWebhookSecret(botApiToken: string | undefined): string {
  const t = (botApiToken ?? "").trim();
  if (!t) return "";
  return crypto.createHash("sha256").update(t).digest("hex").slice(0, 32);
}

export const telegramUpdateSchema = z
  .object({
    update_id: z.number().optional(),
    message: z
      .object({
        chat: z.object({ id: z.number() }).passthrough(),
        from: z
          .object({
            id: z.number().optional(),
            username: z.string().optional().nullable(),
            first_name: z.string().optional().nullable(),
            last_name: z.string().optional().nullable(),
          })
          .partial()
          .optional(),
        text: z.string().optional(),
      })
      .partial()
      .optional(),
  })
  .passthrough();

export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;

/**
 * Shared update handler — called by both the webhook receiver and the
 * long-polling worker. Recognises `/start <code>` deep-link payloads,
 * completes the link, and replies in the same chat. Returns `true` if
 * the update was matched and processed (success or graceful failure),
 * `false` if it was an unrelated update (other command / non-message).
 *
 * Throws are caught by the caller — webhook returns 200 anyway (no
 * retry), poller logs and continues to the next update (the offset
 * still advances so we don't loop on a poison message).
 */
export interface ProcessTelegramUpdateDeps {
  readonly telegram: TelegramService;
  /**
   * Опциональный — нужен для нового signup-flow (`/start s_<nonce>`).
   * Если не задан, signup-коды получают friendly "сервис недоступен".
   */
  readonly signup?: import("../auth-telegram-signup/signup.service.js").TelegramSignupService;
}

export async function processTelegramUpdate(
  update: TelegramUpdate,
  deps: ProcessTelegramUpdateDeps,
): Promise<boolean> {
  const { telegram, signup } = deps;
  const msg = update.message;
  if (!msg || typeof msg.text !== "string" || !msg.chat?.id) {
    return false;
  }
  // Task #45: support both `/start <code>` (с payload) и bare `/start`
  // (без payload). С payload → legacy link-flow или signup-nonce. Без —
  // identifies user by TG-id и регистрирует / отправляет login-link.
  const withPayload = msg.text.trim().match(/^\/start(?:@\S+)?\s+(\S+)/i);
  const bareStart = msg.text.trim().match(/^\/start(?:@\S+)?\s*$/i);
  if (!withPayload && !bareStart) return false;
  const rawCode = withPayload ? withPayload[1]! : null;
  const chatId = msg.chat.id;
  const tgUsername = msg.from?.username?.trim() || null;
  const telegramUserId = msg.from?.id;
  const firstName = msg.from?.first_name?.trim() || null;
  const lastName = msg.from?.last_name?.trim() || null;

  // Dispatcher: `s_<nonce>` → новый signup-flow (anonymous user creates
  // account from /login). Иначе — legacy link-existing-account flow
  // через `telegram_links` table (/preferences «Авторизоваться в TG»).
  const { parseSignupStartCode, parseResetStartCode, SignupNonceError, defaultSignupBotMessages } =
    await import("../auth-telegram-signup/signup.service.js");
  const signupRawNonce = rawCode ? parseSignupStartCode(rawCode) : null;
  const resetRawNonce = rawCode ? parseResetStartCode(rawCode) : null;

  // Task #46: helper для inline-keyboard под welcome DM. Кнопка "🚀 Войти
  // автоматически" с URL = finishUrl → click → cookies + auto-login на сайте.
  const buildLoginKeyboard = (finishUrl: string) => ({
    inline_keyboard: [[{ text: "🚀 Войти на сайт автоматически", url: finishUrl }]],
  });

  if (signupRawNonce) {
    if (!signup) {
      await telegram.sendToChat(
        chatId,
        "❌ Сервис регистрации временно недоступен. Попробуйте позже.",
      );
      return true;
    }
    if (typeof telegramUserId !== "number") {
      // Без telegram_user_id мы не можем создать / найти юзера.
      await telegram.sendToChat(
        chatId,
        "❌ Не удалось определить ваш Telegram ID. Откройте Telegram и попробуйте снова.",
      );
      return true;
    }
    try {
      const r = await signup.handleBotStart({
        rawNonce: signupRawNonce,
        telegramUserId,
        telegramChatId: chatId,
        telegramUsername: tgUsername,
        firstName,
        lastName,
      });
      await telegram.sendToChat(
        chatId,
        defaultSignupBotMessages.ok(
          r.finishUrl,
          r.createdNewUser,
          r.initialCredentials,
        ),
        buildLoginKeyboard(r.finishUrl),
      );
    } catch (e) {
      if (e instanceof SignupNonceError) {
        await telegram.sendToChat(
          chatId,
          defaultSignupBotMessages.error(e.reason),
        );
        return true;
      }
      throw e;
    }
    return true;
  }

  // Task #47: password reset через Telegram. `r_<nonce>` → бот lookup'ит
  // user по TG-id; existing → новый пароль + DM, new → register как
  // обычный signup.
  if (resetRawNonce) {
    if (!signup) {
      await telegram.sendToChat(
        chatId,
        "❌ Сервис восстановления пароля недоступен. Попробуйте позже.",
      );
      return true;
    }
    if (typeof telegramUserId !== "number") {
      await telegram.sendToChat(
        chatId,
        "❌ Не удалось определить ваш Telegram ID. Откройте Telegram и попробуйте снова.",
      );
      return true;
    }
    try {
      const r = await signup.handleBotReset({
        rawNonce: resetRawNonce,
        telegramUserId,
        telegramChatId: chatId,
        telegramUsername: tgUsername,
        firstName,
        lastName,
      });
      await telegram.sendToChat(
        chatId,
        defaultSignupBotMessages.passwordReset(
          r.finishUrl,
          r.createdNewUser,
          r.credentials,
        ),
        buildLoginKeyboard(r.finishUrl),
      );
    } catch (e) {
      if (e instanceof SignupNonceError) {
        await telegram.sendToChat(
          chatId,
          defaultSignupBotMessages.error(e.reason),
        );
        return true;
      }
      throw e;
    }
    return true;
  }

  // Task #45: bare /start (no payload) — auto-detect existing user by TG-id.
  // New → register + creds + finish-link. Existing → send fresh finish-link
  // (без creds).
  if (bareStart) {
    if (!signup) {
      await telegram.sendToChat(
        chatId,
        "👋 Привет! Это Capflow-бот. Откройте https://cap-flow.ru → «Войти через Telegram».",
      );
      return true;
    }
    if (typeof telegramUserId !== "number") {
      await telegram.sendToChat(
        chatId,
        "❌ Не удалось определить ваш Telegram ID.",
      );
      return true;
    }
    const r = await signup.handleBareBotStart({
      telegramUserId,
      telegramChatId: chatId,
      telegramUsername: tgUsername,
      firstName,
      lastName,
    });
    await telegram.sendToChat(
      chatId,
      defaultSignupBotMessages.ok(
        r.finishUrl,
        r.createdNewUser,
        r.initialCredentials,
      ),
      buildLoginKeyboard(r.finishUrl),
    );
    return true;
  }

  // Legacy link-existing-account flow.
  if (!rawCode) return true; // bare /start уже handled выше
  const link = await telegram.completeLink({
    rawCode,
    chatId,
    telegramUsername: tgUsername,
  });
  if (!link) {
    await telegram.sendToChat(
      chatId,
      "❌ Код активации недействителен или истёк. Откройте /preferences в Capflow и нажмите *Авторизоваться в Telegram* ещё раз.",
    );
  } else {
    await telegram.sendToChat(
      chatId,
      "✅ Готово! Ваш Capflow-аккаунт связан с этим Telegram-чатом.\n\n" +
        "Теперь вы будете получать здесь уведомления о ваших позициях.\n" +
        "Откройте /preferences в Capflow чтобы выбрать какие именно события приходят.",
    );
  }
  return true;
}

interface WebhookOptions {
  readonly telegram: TelegramService;
  readonly getBotApiToken: () => string | undefined;
  readonly signup?: import("../auth-telegram-signup/signup.service.js").TelegramSignupService;
}

export async function telegramWebhookRoutes(
  app: FastifyInstance,
  opts: WebhookOptions,
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();

  // POST /webhooks/telegram — receives Updates from api.telegram.org.
  // No auth / no CSRF; the secret_token header is the only gate.
  route.post(
    "/",
    {
      schema: {
        body: z.unknown(),
        response: {
          200: z.object({ ok: z.boolean() }),
          401: z.object({ ok: z.literal(false) }),
          503: z.object({ ok: z.literal(false) }),
        },
      },
      // Telegram doesn't follow our CSRF cookie scheme — webhook
      // requests come from their backend without browser cookies.
      config: { skipCsrf: true },
    },
    async (req, reply) => {
      const expected = deriveWebhookSecret(opts.getBotApiToken());
      if (!expected) {
        // Token not configured — bot can't possibly have a valid
        // webhook. Reject to avoid replay confusion.
        reply.code(503);
        return { ok: false };
      }
      const got =
        (req.headers["x-telegram-bot-api-secret-token"] as string | undefined) ??
        "";
      // Constant-time compare to avoid timing attacks even though the
      // secret is medium-entropy (sha256 prefix).
      const a = Buffer.from(expected);
      const b = Buffer.from(got);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        reply.code(401);
        return { ok: false };
      }

      const parsed = telegramUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        app.log.warn(
          { err: parsed.error.message },
          "[telegram-webhook] malformed update body",
        );
        return { ok: true };
      }
      try {
        await processTelegramUpdate(parsed.data, {
          telegram: opts.telegram,
          ...(opts.signup ? { signup: opts.signup } : {}),
        });
      } catch (e) {
        app.log.error(
          { err: (e as Error).message },
          "[telegram-webhook] completeLink/send failed",
        );
        // Still 200 — Telegram retries on non-2xx; poison messages
        // shouldn't perma-stick.
      }
      return { ok: true };
    },
  );
}

/* ─────────────────────────────────────────────────────────────────── */

const setupResponseSchema = z.object({
  ok: z.boolean(),
  url: z.string(),
  secretConfigured: z.boolean(),
  /**
   * Verbatim Telegram response when reachable; otherwise an
   * `{ error: string }` object explaining what went wrong locally
   * (no token, localhost URL, proxy failure, etc.). UI shows it as
   * a single text line.
   */
  telegramResponse: z.unknown(),
});

interface SetupOptions {
  readonly getBotApiToken: () => string | undefined;
  readonly proxyState: TelegramProxyState;
}

/**
 * POST /admin/telegram/setup-webhook — registers the webhook URL with
 * api.telegram.org via setWebhook. Idempotent: Telegram accepts the same
 * URL+secret repeatedly. Routes through `TelegramProxyState` dispatcher
 * so the call goes through the same proxy as outgoing messages.
 */
export async function telegramWebhookAdminRoutes(
  app: FastifyInstance,
  opts: SetupOptions,
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAdmin);

  // Quick diagnostic — пробует достучаться до api.telegram.org через
  // текущий прокси-стейт и возвращает развёрнутый результат. Не меняет
  // ничего в Telegram. Удобно когда setup-webhook падает с "fetch failed"
  // и нужно понять что конкретно сломано.
  route.post(
    "/test-proxy",
    {
      schema: {
        response: {
          200: z.object({
            ok: z.boolean(),
            proxyConfigured: z.boolean(),
            proxyKind: z.string().nullable(),
            durationMs: z.number(),
            telegramResponse: z.unknown(),
          }),
        },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const token = opts.getBotApiToken()?.trim();
      if (!token) {
        return {
          ok: false,
          proxyConfigured: false,
          proxyKind: null,
          durationMs: 0,
          telegramResponse: {
            error: "TELEGRAM_BOT_API_TOKEN не задан в админке.",
          },
        };
      }
      const proxy = opts.proxyState.currentSync();
      const init = {
        method: "GET" as const,
        ...(proxy?.dispatcher ? { dispatcher: proxy.dispatcher } : {}),
      };
      const t0 = Date.now();
      try {
        const res = await undiciFetch(
          `https://api.telegram.org/bot${token}/getMe`,
          init,
        );
        const dt = Date.now() - t0;
        const json: unknown = await res.json().catch(() => ({
          error: `non-JSON HTTP ${res.status}`,
        }));
        return {
          ok: res.ok,
          proxyConfigured: !!proxy,
          proxyKind: proxy?.kind ?? null,
          durationMs: dt,
          telegramResponse: json,
        };
      } catch (e) {
        return {
          ok: false,
          proxyConfigured: !!proxy,
          proxyKind: proxy?.kind ?? null,
          durationMs: Date.now() - t0,
          telegramResponse: {
            error: describeFetchError(e),
          },
        };
      }
    },
  );

  // GET-equivalent diagnostic: что Telegram сейчас знает о webhook.
  // Возвращает url, pending_update_count, last_error_date/message,
  // ip_address. Самый полезный single source of truth для отладки
  // «нажал /start — ничего не пришло». POST потому что у нас
  // requireAdmin + CSRF на write-mutations; читать через POST с
  // пустым body — нет body, нет mutation.
  route.post(
    "/webhook-info",
    {
      schema: {
        response: {
          200: z.object({
            ok: z.boolean(),
            tokenConfigured: z.boolean(),
            proxyKind: z.string().nullable(),
            durationMs: z.number(),
            telegramResponse: z.unknown(),
          }),
        },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const token = opts.getBotApiToken()?.trim();
      if (!token) {
        return {
          ok: false,
          tokenConfigured: false,
          proxyKind: null,
          durationMs: 0,
          telegramResponse: {
            error: "TELEGRAM_BOT_API_TOKEN не задан в админке.",
          },
        };
      }
      const proxy = opts.proxyState.currentSync();
      const init = {
        method: "GET" as const,
        ...(proxy?.dispatcher ? { dispatcher: proxy.dispatcher } : {}),
      };
      const t0 = Date.now();
      try {
        const res = await undiciFetch(
          `https://api.telegram.org/bot${token}/getWebhookInfo`,
          init,
        );
        const dt = Date.now() - t0;
        const json: unknown = await res.json().catch(() => ({
          error: `non-JSON HTTP ${res.status}`,
        }));
        return {
          ok: res.ok,
          tokenConfigured: true,
          proxyKind: proxy?.kind ?? null,
          durationMs: dt,
          telegramResponse: json,
        };
      } catch (e) {
        return {
          ok: false,
          tokenConfigured: true,
          proxyKind: proxy?.kind ?? null,
          durationMs: Date.now() - t0,
          telegramResponse: { error: describeFetchError(e) },
        };
      }
    },
  );

  // Delete the registered webhook so the bot can switch to long-polling.
  // Telegram refuses getUpdates with 409 «terminated by other getUpdates
  // request» if a webhook is still registered. Idempotent — calling on
  // an already-empty bot returns ok:true with description "Webhook is
  // already deleted".
  route.post(
    "/delete-webhook",
    {
      schema: {
        response: {
          200: z.object({
            ok: z.boolean(),
            proxyKind: z.string().nullable(),
            durationMs: z.number(),
            telegramResponse: z.unknown(),
          }),
        },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const token = opts.getBotApiToken()?.trim();
      if (!token) {
        return {
          ok: false,
          proxyKind: null,
          durationMs: 0,
          telegramResponse: {
            error: "TELEGRAM_BOT_API_TOKEN не задан в админке.",
          },
        };
      }
      const proxy = opts.proxyState.currentSync();
      const init = {
        method: "POST" as const,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ drop_pending_updates: false }),
        ...(proxy?.dispatcher ? { dispatcher: proxy.dispatcher } : {}),
      };
      const t0 = Date.now();
      try {
        const res = await undiciFetch(
          `https://api.telegram.org/bot${token}/deleteWebhook`,
          init,
        );
        const dt = Date.now() - t0;
        const json: unknown = await res.json().catch(() => ({
          error: `non-JSON HTTP ${res.status}`,
        }));
        return {
          ok: res.ok,
          proxyKind: proxy?.kind ?? null,
          durationMs: dt,
          telegramResponse: json,
        };
      } catch (e) {
        return {
          ok: false,
          proxyKind: proxy?.kind ?? null,
          durationMs: Date.now() - t0,
          telegramResponse: { error: describeFetchError(e) },
        };
      }
    },
  );

  route.post(
    "/setup-webhook",
    { schema: { response: { 200: setupResponseSchema } } },
    async (req) => {
      // Top-level try/catch ловит ВСЁ неожиданное и возвращает
      // структурированный 200 — иначе fastify-zod валидация схемы
      // ответа или необработанный throw превращаются в опаковый 500.
      try {
        return await handleSetupWebhook(req, opts);
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        const stack = (e as Error)?.stack?.split("\n").slice(0, 3).join("\n");
        app.log.error(
          { err: msg, stack },
          "[telegram-setup-webhook] unexpected error",
        );
        return {
          ok: false,
          url: "",
          secretConfigured: false,
          telegramResponse: {
            error: `Серверная ошибка: ${msg}`,
          },
        };
      }
    },
  );
}

async function handleSetupWebhook(
  req: { user?: { id: string }; headers: Record<string, string | string[] | undefined> },
  opts: SetupOptions,
): Promise<{
  ok: boolean;
  url: string;
  secretConfigured: boolean;
  telegramResponse: unknown;
}> {
  const u = req.user;
  if (!u) throw new UnauthorizedError();

  const token = opts.getBotApiToken()?.trim();
  if (!token) {
    return {
      ok: false,
      url: "",
      secretConfigured: false,
      telegramResponse: {
        error:
          "TELEGRAM_BOT_API_TOKEN не задан. Откройте /admin/integrations → Telegram → API Token и вставьте токен из BotFather.",
      },
    };
  }

  // Headers могут быть string | string[] | undefined. На Caddy/Vite
  // обычно строка, но защитимся от array case.
  const rawHost = req.headers["x-forwarded-host"] ?? req.headers.host;
  const host = Array.isArray(rawHost) ? rawHost[0] : rawHost;
  if (!host) {
    return {
      ok: false,
      url: "",
      secretConfigured: false,
      telegramResponse: {
        error: "Не удалось определить публичный hostname из request.",
      },
    };
  }

  const rawProto = req.headers["x-forwarded-proto"];
  const proto = (
    Array.isArray(rawProto) ? rawProto[0] : rawProto
  )?.toLowerCase();
  const isHttps = proto === "https";
  const webhookUrl = `${isHttps ? "https" : "http"}://${host}/api/v1/webhooks/telegram`;

  // Telegram требует публичный HTTPS URL — отклоняет localhost/127.0.0.1
  // и любой http://. Сразу даём явную ошибку вместо отправки бесполезного
  // запроса.
  const isLocal =
    host.startsWith("localhost") ||
    host.startsWith("127.") ||
    host.includes(":5173") ||
    host.includes(":3000");
  if (isLocal || !isHttps) {
    return {
      ok: false,
      url: webhookUrl,
      secretConfigured: !!deriveWebhookSecret(token),
      telegramResponse: {
        error:
          `Webhook URL '${webhookUrl}' Telegram отвергнет — нужен публичный HTTPS. ` +
          `Для локалки используйте ngrok (ngrok http <port> + setup из тоннельного URL) ` +
          `или сначала задеплойте в прод и регистрируйте webhook оттуда.`,
      },
    };
  }

  const secret = deriveWebhookSecret(token);
  const body = {
    url: webhookUrl,
    secret_token: secret,
    // Receive only message updates — we don't handle callbacks etc.
    allowed_updates: ["message"],
    drop_pending_updates: false,
  };
  const proxy = opts.proxyState.currentSync();
  const init = {
    method: "POST" as const,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...(proxy?.dispatcher ? { dispatcher: proxy.dispatcher } : {}),
  };

  let res: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    res = await undiciFetch(
      `https://api.telegram.org/bot${token}/setWebhook`,
      init,
    );
  } catch (e) {
    // undici оборачивает реальную причину в .cause — surface всю цепочку,
    // иначе видим бесполезное "fetch failed".
    const reason = describeFetchError(e);
    return {
      ok: false,
      url: webhookUrl,
      secretConfigured: !!secret,
      telegramResponse: {
        error:
          `Не удалось достучаться до api.telegram.org` +
          (proxy ? ` через прокси (${proxy.kind})` : "") +
          `: ${reason}. ` +
          (proxy
            ? `Возможные причины: прокси упал, не поддерживает HTTP CONNECT для HTTPS, неверные креды, или Telegram заблокирован для этого IP. ` +
              `Проверьте через "Тест прокси" в админке.`
            : `Возможно нужен прокси — настройте Telegram Bot Proxy в админке.`),
      },
    };
  }
  const json: unknown = await res.json().catch(() => ({
    error: `Telegram вернул не-JSON: HTTP ${res.status}`,
  }));
  return {
    ok: res.ok,
    url: webhookUrl,
    secretConfigured: !!secret,
    telegramResponse: json,
  };
}

/**
 * undici-style fetch errors hide the real reason in `.cause` (sometimes
 * deeply nested). Walk the chain and pull out a readable description.
 */
function describeFetchError(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  let depth = 0;
  while (cur && depth < 5) {
    const err = cur as { message?: string; code?: string; cause?: unknown };
    const piece =
      [err.code, err.message].filter(Boolean).join(" ").trim() ||
      String(cur);
    if (piece && !parts.includes(piece)) parts.push(piece);
    cur = err.cause;
    depth++;
  }
  return parts.join(" ← ") || "unknown error";
}

