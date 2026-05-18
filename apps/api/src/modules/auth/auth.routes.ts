import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { z } from "zod";

import type { Env } from "../../config/env.js";
import { ForbiddenError, UnauthorizedError } from "../../core/errors.js";
import type { AdminUsersService } from "../admin-users/admin-users.service.js";

import {
  REFRESH_COOKIE_NAME,
  clearAccessCookie,
  clearRefreshCookie,
  setAccessCookie,
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

      return {
        accessToken: tokens.accessToken,
        expiresAt: tokens.accessTokenExpiresAt.toISOString(),
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

      // Preserve impersonation context across refresh rotation. The
      // service layer keeps impersonatedById on the new session when
      // the original was an impersonation; we surface it on /me so the
      // dashboard's red banner survives a page reload.
      return {
        accessToken: tokens.accessToken,
        expiresAt: tokens.accessTokenExpiresAt.toISOString(),
        user: toMe(tokens.user, tokens.impersonation ?? null),
      };
    }
  );

  route.post("/logout", {}, async (req, reply) => {
    const cookie = req.cookies[REFRESH_COOKIE_NAME];
    await app.auth.logout(cookie);
    clearRefreshCookie(reply, cookieCfg);
    clearAccessCookie(reply, accessCookieCfg);
    return reply.status(204).send();
  });

  route.get(
    "/me",
    {
      preHandler: app.requireAuth,
      schema: { response: { 200: meResponseSchema } },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const full = await app.auth.getActiveUser(u.id);
      if (!full) throw new UnauthorizedError("User no longer active.");
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
      return {
        accessToken: result.adminTokens.accessToken,
        expiresAt: result.adminTokens.accessTokenExpiresAt.toISOString(),
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
      return reply.status(204).send();
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
    email: u.email ?? "",
    name: deriveName(u),
    role: u.role as UserRole,
    createdAt: u.createdAt.toISOString(),
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    emailVerifiedAt: u.emailVerifiedAt ? u.emailVerifiedAt.toISOString() : null,
    impersonation,
  };
}
