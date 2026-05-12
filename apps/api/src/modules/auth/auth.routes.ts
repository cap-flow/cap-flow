import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { Env } from "../../config/env.js";
import { UnauthorizedError } from "../../core/errors.js";

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

      // Refresh rotation always mints a fresh, non-impersonated session
      // server-side (see auth.service.refresh — createSession is called
      // without impersonatedById). So the post-refresh /me also has no
      // impersonation context.
      return {
        accessToken: tokens.accessToken,
        expiresAt: tokens.accessTokenExpiresAt.toISOString(),
        user: toMe(tokens.user, null),
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
    impersonation,
  };
}
