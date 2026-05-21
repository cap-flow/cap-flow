/**
 * HTTP-routes для Telegram-signup потока.
 *
 *   POST /v1/auth/telegram/start-signup    (anonymous)
 *   GET  /v1/auth/telegram/finish?nonce=…  (anonymous; sets cookies + 302)
 *   POST /v1/auth/set-password             (authenticated)
 *
 * `processTelegramUpdate` dispatcher живёт отдельно — в
 * `telegram.webhook.routes.ts`, потому что bot-сторона не имеет
 * Fastify-route'а (это update handler из poller'a). Здесь только
 * web-side endpoints.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { Env } from "../../config/env.js";
import { UnauthorizedError } from "../../core/errors.js";
import {
  generateCsrfToken,
  setAccessCookie,
  setCsrfCookie,
  setRefreshCookie,
} from "../auth/auth.cookies.js";
import type { AuthService } from "../auth/auth.service.js";

import type { TelegramSignupService } from "./signup.service.js";

export interface TelegramSignupRoutesOptions {
  readonly env: Env;
  readonly signup: TelegramSignupService;
  readonly auth: AuthService;
}

const usernameSchema = z
  .string()
  .min(3, "Логин минимум 3 символа")
  .max(32)
  .regex(/^[a-zA-Z0-9_]+$/, "Только латиница, цифры и _");

const setPasswordBodySchema = z.object({
  password: z
    .string()
    .min(8, "Пароль минимум 8 символов")
    .max(200),
  // Опционально — если не передан, оставляем username NULL (юзер может
  // потом установить в profile). Если передан — проверяем формат.
  username: usernameSchema.optional(),
});

export async function telegramSignupRoutes(
  app: FastifyInstance,
  opts: TelegramSignupRoutesOptions,
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  const { env, signup, auth } = opts;

  const cookieCfg = {
    secure: env.COOKIE_SECURE,
    domain: env.COOKIE_DOMAIN,
    maxAgeSeconds: env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60,
  };
  const accessCookieCfg = {
    secure: env.COOKIE_SECURE,
    domain: env.COOKIE_DOMAIN,
    maxAgeSeconds: Math.min(env.JWT_ACCESS_TTL_MIN * 60, 24 * 3600),
  };
  const csrfCookieCfg = {
    secure: env.COOKIE_SECURE,
    domain: env.COOKIE_DOMAIN,
    maxAgeSeconds: env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60,
  };

  // ─── POST /v1/auth/telegram/start-signup ─────────────────────────────
  // Anonymous. Rate-limited агрессивно (10/мин per IP) чтобы абьюзеры
  // не загаживали nonce-таблицу.
  route.post(
    "/start-signup",
    {
      schema: {
        response: {
          200: z.object({
            botDeepLink: z.string(),
            // Клиент НЕ хранит rawNonce — он живёт только в боте +
            // в finishUrl, который придёт в чат.
          }),
        },
      },
      config: {
        skipCsrf: true,
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
    },
    async () => {
      const r = await signup.startSignup();
      return { botDeepLink: r.botDeepLink };
    },
  );

  // ─── GET /v1/auth/telegram/finish?nonce=… ────────────────────────────
  // Anonymous. Атомарно consume nonce, выпускает cookies, 302 на /.
  // Если nonce невалиден → 302 на /login?error=expired_link (UI покажет
  // friendly сообщение).
  route.get(
    "/finish",
    {
      schema: {
        querystring: z.object({ nonce: z.string().min(8).max(200) }),
      },
      config: {
        skipCsrf: true,
        // Этот endpoint навигационный (302 redirect), но всё равно
        // защищаем от мусорных запросов.
        rateLimit: { max: 30, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const outcome = await signup.finishLogin(req.query.nonce);
      if (outcome.kind === "gone") {
        // 302 на /login с error-параметром — UI покажет toast.
        return reply.redirect("/login?error=expired_link", 302);
      }
      const tokens = await auth.issueTokensForUser(outcome.user, {
        userAgent: req.headers["user-agent"] ?? null,
        ip: req.ip ?? null,
      });
      setRefreshCookie(reply, tokens.refreshToken, cookieCfg);
      setAccessCookie(reply, tokens.accessToken, accessCookieCfg);
      const csrf = generateCsrfToken();
      setCsrfCookie(reply, csrf, csrfCookieCfg);

      const dest = outcome.needsPasswordSetup ? "/auth/set-password" : "/";
      return reply.redirect(dest, 302);
    },
  );

  // ─── POST /v1/auth/set-password (authenticated) ──────────────────────
  // Только для юзеров чей passwordHash сейчас NULL (одноразовое
  // действие). Запрещаем overwrite — если кто-то уже задал пароль
  // через этот endpoint, повторный вызов отвергаем (используйте
  // обычный flow смены пароля).
  route.post(
    "/set-password",
    {
      schema: {
        body: setPasswordBodySchema,
        response: {
          200: z.object({ ok: z.literal(true) }),
          409: z.object({
            error: z.string(),
            field: z.enum(["username", "password"]).optional(),
          }),
        },
      },
      preHandler: app.requireAuth,
      config: {
        rateLimit: { max: 5, timeWindow: "5 minutes" },
      },
    },
    async (req, reply) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();

      // getUserAnyStatus, не getActiveUser — наш typical caller имеет
      // status="pending" (signup-юзер, ещё не прошедший set-password).
      // requireAuth уже отсёк blocked-юзеров.
      const fullUser = await auth.getUserAnyStatus(u.id);
      if (!fullUser) {
        // Юзер удалён в гонке — cookie всё ещё валидный, но user gone.
        throw new UnauthorizedError();
      }
      if (fullUser.passwordHash) {
        reply.code(409);
        return {
          error:
            "Пароль уже задан. Для смены пароля используйте обычный flow восстановления.",
          field: "password" as const,
        };
      }

      const passwordHash = await auth.hashPasswordForStorage(req.body.password);
      try {
        await signup.setInitialPassword(
          fullUser.id,
          passwordHash,
          req.body.username ?? null,
        );
      } catch (e) {
        // Unique-conflict на username — Postgres код 23505.
        const msg = (e as Error).message ?? "";
        if (/duplicate key|unique/i.test(msg) && msg.includes("username")) {
          reply.code(409);
          return {
            error: "Этот логин уже занят. Выберите другой.",
            field: "username" as const,
          };
        }
        throw e;
      }
      return { ok: true as const };
    },
  );
}
