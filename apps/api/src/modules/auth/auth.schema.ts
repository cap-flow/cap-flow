import { z } from "zod";

export const loginBodySchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});

export const impersonationInfoSchema = z.object({
  impersonatorId: z.string().uuid(),
  mode: z.enum(["view", "edit"]),
});

export const meResponseSchema = z.object({
  id: z.string().uuid(),
  // Telegram-signup users могут не иметь email — nullable, чтобы /me
  // не падал на zod после signup. Legacy email/password юзеры всегда
  // имеют email.
  email: z.string().nullable(),
  name: z.string().nullable(),
  /**
   * Unique username (3-32 [a-zA-Z0-9_]). Заполняется на set-password
   * page после Telegram-signup. NULL для legacy email-only юзеров и
   * для signup-юзеров, ещё не прошедших set-password.
   */
  username: z.string().nullable(),
  /** Telegram identity (если юзер прошёл signup / linked bot). */
  telegramUsername: z.string().nullable(),
  /** True если password_hash ещё не задан — фронт ведёт на /auth/set-password. */
  needsPasswordSetup: z.boolean(),
  role: z.enum(["admin", "user", "viewer"]),
  createdAt: z.string().datetime(),
  lastLoginAt: z.string().datetime().nullable(),
  /** B4: email verification timestamp; NULL = not verified yet. */
  emailVerifiedAt: z.string().datetime().nullable(),
  /** Present iff the current session is an admin acting as this user.
   *  Frontend uses it to render the persistent "you're impersonating X" banner. */
  impersonation: impersonationInfoSchema.nullable(),
});

export const loginResponseSchema = z.object({
  /**
   * Access JWT. DEPRECATED (TODO 2026-06-XX remove):
   * after the cookie-based auth migration the access token lives in
   * the `cap_access` HttpOnly cookie; the JSON copy is kept only to
   * unblock callers (and tests) that still read it from the body.
   */
  accessToken: z.string(),
  expiresAt: z.string().datetime(),
  /**
   * CSRF double-submit token. Mirrored in the `cap_csrf` cookie
   * (httpOnly=false) so the frontend can read it from
   * `document.cookie`. Frontends that prefer not to touch
   * `document.cookie` can pick it up here.
   */
  csrfToken: z.string().optional(),
  user: meResponseSchema,
});

export type LoginBody = z.infer<typeof loginBodySchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type LoginResponse = z.infer<typeof loginResponseSchema>;
