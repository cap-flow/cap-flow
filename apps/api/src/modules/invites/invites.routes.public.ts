import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { Env } from "../../config/env.js";
import {
  REFRESH_COOKIE_NAME,
  setRefreshCookie,
} from "../auth/auth.cookies.js";
import { loginResponseSchema } from "../auth/auth.schema.js";
import type { UserRow } from "../auth/auth.repository.js";

import {
  invitePublicResponseSchema,
  registerFromInviteBodySchema,
  tokenParamSchema,
} from "./invites.schema.js";
import type { InvitesService } from "./invites.service.js";

interface PublicInviteRoutesOptions {
  readonly invites: InvitesService;
  readonly env: Env;
}

export async function publicInviteRoutes(
  app: FastifyInstance,
  opts: PublicInviteRoutesOptions
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  const { invites, env } = opts;

  const cookieCfg = {
    secure: env.COOKIE_SECURE,
    domain: env.COOKIE_DOMAIN,
    maxAgeSeconds: env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60,
  };

  route.get(
    "/:token",
    {
      schema: {
        params: tokenParamSchema,
        response: { 200: invitePublicResponseSchema },
      },
      config: {
        // Limit reconnaissance via invite-URL guessing.
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
    },
    async (req) => {
      const preview = await invites.previewByToken(req.params.token);
      return {
        email: preview.email,
        expiresAt: preview.expiresAt.toISOString(),
      };
    }
  );

  route.post(
    "/:token/register",
    {
      schema: {
        params: tokenParamSchema,
        body: registerFromInviteBodySchema,
        response: { 201: loginResponseSchema },
      },
      config: {
        rateLimit: { max: 5, timeWindow: "15 minutes" },
      },
    },
    async (req, reply) => {
      const tokens = await invites.registerByToken({
        token: req.params.token,
        password: req.body.password,
        name: req.body.name,
        userAgent: req.headers["user-agent"] ?? null,
        ip: req.ip ?? null,
      });

      setRefreshCookie(reply, tokens.refreshToken, cookieCfg);

      return reply.status(201).send({
        accessToken: tokens.accessToken,
        expiresAt: tokens.accessTokenExpiresAt.toISOString(),
        user: toMe(tokens.user),
      });
    }
  );
}

function toMe(u: UserRow) {
  return {
    id: u.id,
    email: u.email ?? "",
    name:
      (u.name && u.name.trim()) ||
      [u.firstName, u.lastName].filter(Boolean).join(" ").trim() ||
      (u.email ? u.email.split("@")[0]! : "user"),
    role: u.role as "admin" | "user" | "viewer",
    createdAt: u.createdAt.toISOString(),
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    // Self-register can never establish an impersonation session.
    impersonation: null,
  };
}

// Silence unused — REFRESH_COOKIE_NAME may be useful when adding revoke-on-register.
void REFRESH_COOKIE_NAME;
