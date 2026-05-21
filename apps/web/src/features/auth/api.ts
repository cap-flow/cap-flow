import { z } from "zod";

import { api } from "@/lib/api/client";

export const userRoleSchema = z.enum(["admin", "user", "viewer"]);
export type UserRole = z.infer<typeof userRoleSchema>;

export const impersonationInfoSchema = z.object({
  impersonatorId: z.string().uuid(),
  mode: z.enum(["view", "edit"]),
});
export type ImpersonationInfo = z.infer<typeof impersonationInfoSchema>;

export const meSchema = z.object({
  id: z.string().uuid(),
  // Nullable для Telegram-signup юзеров (email ещё не задан).
  email: z.string().nullable(),
  name: z.string().nullable(),
  username: z.string().nullable(),
  telegramUsername: z.string().nullable(),
  needsPasswordSetup: z.boolean(),
  role: userRoleSchema,
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
  emailVerifiedAt: z.string().nullable(),
  impersonation: impersonationInfoSchema.nullable(),
});
export type Me = z.infer<typeof meSchema>;

export const loginResponseSchema = z.object({
  accessToken: z.string(),
  expiresAt: z.string(),
  user: meSchema,
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export interface LoginInput {
  readonly email: string;
  readonly password: string;
}

export const authApi = {
  /** POST /api/v1/auth/login — sets refresh cookie + returns access token. */
  login: (input: LoginInput) =>
    api.postPublic("/v1/auth/login", input, loginResponseSchema),

  /** GET /api/v1/auth/me — returns current user (requires access token). */
  me: () => api.get("/v1/auth/me", meSchema),

  /** POST /api/v1/auth/logout — clears refresh cookie + revokes session. */
  logout: () =>
    api.post("/v1/auth/logout", undefined as unknown, z.unknown()),

  /** POST /api/v1/auth/end-impersonation — stops the current impersonation
   *  session and restores admin tokens. Identifies the admin via session
   *  metadata; requires only auth (not requireAdmin) since the caller IS
   *  the impersonated user. */
  endImpersonation: () =>
    api.post(
      "/v1/auth/end-impersonation",
      undefined as unknown,
      z.object({
        accessToken: z.string(),
        expiresAt: z.string(),
        user: meSchema,
      }),
    ),

  /**
   * POST /api/v1/auth/telegram/start-signup — генерит one-shot nonce
   * и возвращает t.me deep-link. Anonymous endpoint.
   * Откройте `botDeepLink` в новой вкладке — пользователь нажимает
   * /start у бота, после чего получит в чат уникальную ссылку обратно
   * на /login/finish?nonce=…
   */
  startTelegramSignup: () =>
    api.postPublic(
      "/v1/auth/telegram/start-signup",
      undefined as unknown,
      z.object({ botDeepLink: z.string() }),
    ),

  /**
   * POST /api/v1/auth/telegram/set-password — одноразовое действие
   * после signup-flow login. Доступно ТОЛЬКО когда у юзера ещё нет
   * password_hash. UNIQUE-conflict на username → 409.
   */
  setInitialPassword: (input: {
    password: string;
    username?: string;
  }) =>
    api.post(
      "/v1/auth/telegram/set-password",
      input,
      z.object({ ok: z.literal(true) }),
    ),
};
