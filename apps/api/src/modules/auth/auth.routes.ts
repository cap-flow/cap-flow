import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { z } from "zod";

import type { Env } from "../../config/env.js";
import { ForbiddenError, UnauthorizedError } from "../../core/errors.js";
import type { AdminUsersService } from "../admin-users/admin-users.service.js";

import {
  REFRESH_COOKIE_NAME,
  clearAccessCookie,
  clearCsrfCookie,
  clearRefreshCookie,
  generateCsrfToken,
  setAccessCookie,
  setCsrfCookie,
  setRefreshCookie,
} from "./auth.cookies.js";
import {
  loginBodySchema,
  loginResponseSchema,
  meResponseSchema,
} from "./auth.schema.js";
import type { UserRow } from "./auth.repository.js";
import type { UserRole } from "./auth.types.js";

interface AuthRoutesOptions {
  readonly env: Env;
  readonly adminUsers: AdminUsersService;
}

export async function authRoutes(
  app: FastifyInstance,
  opts: AuthRoutesOptions
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  const { env } = opts;

  const cookieCfg = {
    secure: env.COOKIE_SECURE,
    domain: env.COOKIE_DOMAIN,
    maxAgeSeconds: env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60,
  };

  /**
   * Access-cookie matches the access-token TTL. Capped at 24h as a
   * defence-in-depth: even if frontend never calls /refresh, the cookie
   * eventually expires and viem-driven Alchemy calls start failing
   * with 401, forcing a fresh login.
   */
  const accessCookieCfg = {
    secure: env.COOKIE_SECURE,
    domain: env.COOKIE_DOMAIN,
    maxAgeSeconds: Math.min(env.JWT_ACCESS_TTL_MIN * 60, 24 * 3600),
  };

  // CSRF cookie outlives the access cookie (refresh rotation rotates
  // it). We tie it to refresh-token lifetime so a long-lived browser
  // tab without traffic doesn't lose the ability to mutate.
  const csrfCookieCfg = {
    secure: env.COOKIE_SECURE,
    domain: env.COOKIE_DOMAIN,
    maxAgeSeconds: env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60,
  };

  route.post(
    "/login",
    {
      schema: {
        body: loginBodySchema,
        response: { 200: loginResponseSchema },
      },
      config: {
        rateLimit: {
          max: env.RATE_LIMIT_LOGIN_PER_15MIN,
          timeWindow: "15 minutes",
        },
      },
    },
    async (req, reply) => {
      const tokens = await app.auth.login({
        email: req.body.email,
        password: req.body.password,
        userAgent: req.headers["user-agent"] ?? null,
        ip: req.ip ?? null,
      });

      setRefreshCookie(reply, tokens.refreshToken, cookieCfg);
      setAccessCookie(reply, tokens.accessToken, accessCookieCfg);
      const csrf = generateCsrfToken();
      setCsrfCookie(reply, csrf, csrfCookieCfg);

      return {
        accessToken: tokens.accessToken,
        expiresAt: tokens.accessTokenExpiresAt.toISOString(),
        csrfToken: csrf,
        user: toMe(tokens.user, null),
      };
    }
  );

  route.post(
    "/refresh",
    {
      schema: {
        response: { 200: loginResponseSchema },
      },
      config: {
        // /refresh is not pre-authed (it *establishes* the auth), so we
        // can't key by req.user. IP is the right granularity here:
        // protects against a runaway client looping refresh+login and
        // against drive-by brute-force of stolen refresh cookies. 30
        // req/15min comfortably exceeds normal token-rotation traffic
        // (default access TTL is ~15min, so a session refreshes ~once
        // per 15min; 30× headroom for multi-tab and reconnects).
        rateLimit: { max: 30, timeWindow: "15 minutes" },
      },
    },
    async (req, reply) => {
      const cookie = req.cookies[REFRESH_COOKIE_NAME];
      if (!cookie) throw new UnauthorizedError("Missing refresh cookie.");

      const tokens = await app.auth.refresh(cookie, {
        userAgent: req.headers["user-agent"] ?? null,
        ip: req.ip ?? null,
      });

      setRefreshCookie(reply, tokens.refreshToken, cookieCfg);
      setAccessCookie(reply, tokens.accessToken, accessCookieCfg);
      const csrf = generateCsrfToken();
      setCsrfCookie(reply, csrf, csrfCookieCfg);

      // Preserve impersonation context across refresh rotation. The
      // service layer keeps impersonatedById on the new session when
      // the original was an impersonation; we surface it on /me so the
      // dashboard's red banner survives a page reload.
      return {
        accessToken: tokens.accessToken,
        expiresAt: tokens.accessTokenExpiresAt.toISOString(),
        csrfToken: csrf,
        user: toMe(tokens.user, tokens.impersonation ?? null),
      };
    }
  );

  route.post(
    "/logout",
    {
      // Logout is user-initiated and idempotent, so we keep the ceiling
      // generous (20/5min) — well above any realistic click rate but low
      // enough that an attacker can't loop /logout to mass-invalidate
      // sessions if they ever steal a refresh cookie. Keyed per (user
      // when known, else IP) — req.user is only populated when a valid
      // bearer/access cookie is present; logout is otherwise rate-keyed
      // by source IP as a safe default.
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "5 minutes",
          keyGenerator: (req: { user?: { id: string }; ip?: string }) =>
            req.user?.id ?? req.ip ?? "anon",
        },
      },
    },
    async (req, reply) => {
      const cookie = req.cookies[REFRESH_COOKIE_NAME];
      await app.auth.logout(cookie);
      clearRefreshCookie(reply, cookieCfg);
      clearAccessCookie(reply, accessCookieCfg);
      clearCsrfCookie(reply, csrfCookieCfg);
      return reply.status(204).send();
    }
  );

  /**
   * Issue a fresh CSRF token without rotating the session.
   *
   * Frontend bootstrap path: after a hard reload the access cookie may
   * already be valid (server side) but the CSRF cookie was lost (cleared
   * by browser, expired, or never seen because the page was opened
   * directly with credentials from a different tab). Calling /auth/csrf
   * returns a token the frontend can use for the next mutating call
   * without a full re-login.
   *
   * Auth-required: only authenticated callers may mint a token, otherwise
   * an attacker could harvest one before forging a request.
   */
  route.get(
    "/csrf",
    {
      preHandler: app.requireAuth,
      schema: {
        response: { 200: z.object({ csrfToken: z.string() }) },
      },
    },
    async (_req, reply) => {
      const csrf = generateCsrfToken();
      setCsrfCookie(reply, csrf, csrfCookieCfg);
      return { csrfToken: csrf };
    }
  );

  route.get(
    "/me",
    {
      preHandler: app.requireAuth,
      schema: { response: { 200: meResponseSchema } },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      // getUserAnyStatus (не getActiveUser) — /me должен работать для
      // signup-юзеров со status="pending" (до set-password). Они уже
      // прошли requireAuth (который отсекает blocked).
      const full = await app.auth.getUserAnyStatus(u.id);
      if (!full) throw new UnauthorizedError("User no longer exists.");
      return toMe(full, u.impersonation ?? null);
    }
  );

  /**
   * Stop the current impersonation session and return to the admin
   * identity. Lives under /auth (not /admin/users/.../impersonate)
   * because the caller is the *impersonated* user — they don't have
   * admin role, so /admin requires-admin gate would 403. Identity
   * of the admin to restore is read from session metadata
   * (req.user.impersonation.impersonatorId, populated by the auth
   * plugin from sessions.impersonated_by_id).
   */
  route.post(
    "/end-impersonation",
    {
      preHandler: app.requireAuth,
      schema: {
        response: {
          200: z.object({
            accessToken: z.string(),
            expiresAt: z.string(),
            csrfToken: z.string().optional(),
            user: meResponseSchema,
          }),
        },
      },
    },
    async (req, reply) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      if (!u.impersonation) {
        throw new ForbiddenError("Not currently impersonating.");
      }
      const adminId = u.impersonation.impersonatorId;
      const result = await opts.adminUsers.endImpersonations(adminId, u.id, {
        ip: req.ip ?? null,
        userAgent: req.headers["user-agent"] ?? null,
      });
      if (!result.adminTokens) {
        throw new UnauthorizedError("Admin session could not be restored.");
      }
      setRefreshCookie(reply, result.adminTokens.refreshToken, cookieCfg);
      setAccessCookie(reply, result.adminTokens.accessToken, accessCookieCfg);
      const csrf = generateCsrfToken();
      setCsrfCookie(reply, csrf, csrfCookieCfg);
      return {
        accessToken: result.adminTokens.accessToken,
        expiresAt: result.adminTokens.accessTokenExpiresAt.toISOString(),
        csrfToken: csrf,
        user: toMe(result.adminTokens.admin, null),
      };
    }
  );

  /**
   * M16 (2026-05-14): self-delete account (GDPR Art. 17 / 152-ФЗ).
   *
   * User-initiated deletion of their own account + all owned data
   * (cascades through accounts → wallets/operations/snapshots, plus
   * sessions/payments/notifications). Same cascade implementation as
   * the admin route — `mode="self"` only skips the self-protection
   * guard, last-admin safety still applies.
   *
   * Rate-limited harshly: a malicious script that tricks a user into
   * triggering this multiple times shouldn't be able to. 3/hour is
   * way more than any legitimate flow needs.
   */
  route.delete(
    "/me",
    {
      preHandler: app.requireAuth,
      schema: { response: { 204: z.null() } },
      config: {
        rateLimit: { max: 3, timeWindow: "1 hour" },
      },
    },
    async (req, reply) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      // Impersonated session must never trigger self-delete — that
      // would let an admin permanently wipe a user from within their
      // session without an explicit admin action. The user must end
      // impersonation first.
      if (u.impersonation) {
        throw new ForbiddenError(
          "Cannot self-delete from an impersonation session."
        );
      }
      await opts.adminUsers.deleteUser(u.id, u.id, "self");
      clearRefreshCookie(reply, cookieCfg);
      clearAccessCookie(reply, accessCookieCfg);
      clearCsrfCookie(reply, csrfCookieCfg);
      return reply.status(204).send(null);
    }
  );
}

/** name fallback: prefer `name`, then `first_name + last_name`, then email-local-part. */
function deriveName(u: UserRow): string {
  if (u.name && u.name.trim()) return u.name.trim();
  const fl = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  if (fl) return fl;
  if (u.email) return u.email.split("@")[0] ?? u.email;
  return "user";
}

function toMe(
  u: UserRow,
  impersonation: { impersonatorId: string; mode: "view" | "edit" } | null
) {
  return {
    id: u.id,
    // Nullable для Telegram-signup юзеров (email ещё может отсутствовать).
    email: u.email,
    name: u.name ?? deriveName(u),
    username: u.username,
    telegramUsername: u.telegramUsername,
    needsPasswordSetup: !u.passwordHash,
    role: u.role as UserRole,
    createdAt: u.createdAt.toISOString(),
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    emailVerifiedAt: u.emailVerifiedAt ? u.emailVerifiedAt.toISOString() : null,
    impersonation,
  };
}
