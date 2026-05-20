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

const updateSchema = z
  .object({
    message: z
      .object({
        chat: z.object({ id: z.number() }).passthrough(),
        from: z
          .object({
            username: z.string().optional().nullable(),
          })
          .partial()
          .optional(),
        text: z.string().optional(),
      })
      .partial()
      .optional(),
  })
  .passthrough();

interface WebhookOptions {
  readonly telegram: TelegramService;
  readonly getBotApiToken: () => string | undefined;
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

      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) {
        // Malformed update — log and 200 OK so Telegram doesn't retry.
        app.log.warn(
          { err: parsed.error.message },
          "[telegram-webhook] malformed update body",
        );
        return { ok: true };
      }

      const msg = parsed.data.message;
      if (!msg || typeof msg.text !== "string" || !msg.chat?.id) {
        // Non-message update (edited_message, callback_query, …) —
        // ignore for now.
        return { ok: true };
      }

      // Parse `/start <code>` — allow leading whitespace and a trailing
      // `@BotName` suffix some clients append.
      const m = msg.text.trim().match(/^\/start(?:@\S+)?\s+(\S+)/i);
      if (!m) {
        // Some other command/text. Polite no-op for now.
        return { ok: true };
      }
      const rawCode = m[1]!;
      const chatId = msg.chat.id;
      const tgUsername = msg.from?.username?.trim() || null;

      try {
        const link = await opts.telegram.completeLink({
          rawCode,
          chatId,
          telegramUsername: tgUsername,
        });
        if (!link) {
          await opts.telegram.sendToChat(
            chatId,
            "❌ Код активации недействителен или истёк. Откройте /preferences в Capflow и нажмите *Авторизоваться в Telegram* ещё раз.",
          );
        } else {
          await opts.telegram.sendToChat(
            chatId,
            "✅ Готово! Ваш Capflow-аккаунт связан с этим Telegram-чатом.\n\n" +
              "Теперь вы будете получать здесь уведомления о ваших позициях.\n" +
              "Откройте /preferences в Capflow чтобы выбрать какие именно события приходят.",
          );
        }
      } catch (e) {
        app.log.error(
          { err: (e as Error).message },
          "[telegram-webhook] completeLink/send failed",
        );
        // Still 200 — Telegram will retry on non-2xx and we don't want
        // a perma-stuck poison message.
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

  route.post(
    "/setup-webhook",
    { schema: { response: { 200: setupResponseSchema } } },
    async (req) => {
      // Always return 200 with a structured error in `telegramResponse`
      // so the admin UI can render a readable message instead of opaque
      // "500 Internal Server Error". The `ok` field reflects success.
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
      const rawHost =
        req.headers["x-forwarded-host"] ?? req.headers.host;
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
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        ...(proxy?.dispatcher ? { dispatcher: proxy.dispatcher } : {}),
      } as unknown as RequestInit;

      let res: Response;
      try {
        res = await fetch(
          `https://api.telegram.org/bot${token}/setWebhook`,
          init,
        );
      } catch (e) {
        return {
          ok: false,
          url: webhookUrl,
          secretConfigured: !!secret,
          telegramResponse: {
            error:
              `Не удалось достучаться до api.telegram.org` +
              (proxy ? ` через прокси (${proxy.kind})` : "") +
              `: ${(e as Error).message}. Проверьте Telegram Bot Proxy в админке.`,
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
    },
  );
}
