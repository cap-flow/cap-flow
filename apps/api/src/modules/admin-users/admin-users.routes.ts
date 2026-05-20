import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { Env } from "../../config/env.js";
import { UnauthorizedError } from "../../core/errors.js";
import {
  REFRESH_COOKIE_NAME,
  generateCsrfToken,
  setAccessCookie,
  setCsrfCookie,
  setRefreshCookie,
} from "../auth/auth.cookies.js";
import type { UserRow } from "../auth/auth.repository.js";

import type { AdminUsersService } from "./admin-users.service.js";

const userIdParamSchema = z.object({ id: z.string().uuid() });

const listFilterSchema = z.object({
  status: z.enum(["active", "pending", "blocked"]).optional(),
  role: z.enum(["admin", "user", "viewer"]).optional(),
  search: z.string().max(120).optional(),
  // M14: cursor + limit.
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const adminUserResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  role: z.enum(["admin", "user", "viewer"]),
  status: z.enum(["active", "pending", "blocked"]),
  createdAt: z.string().datetime(),
  lastLoginAt: z.string().datetime().nullable(),
});

const adminUserWithAggregatesSchema = adminUserResponseSchema.extend({
  accountCount: z.number(),
  lastSnapshotAt: z.string().datetime().nullable(),
  lastSnapshotUsd: z.number().nullable(),
});

const adminUserListResponseSchema = z.object({
  items: z.array(adminUserWithAggregatesSchema),
  nextCursor: z.string().datetime().nullable(),
});

const setStatusBodySchema = z.object({
  status: z.enum(["active", "pending", "blocked"]),
});

const setRoleBodySchema = z.object({
  role: z.enum(["admin", "user", "viewer"]),
});

const impersonateResponseSchema = z.object({
  accessToken: z.string(),
  expiresAt: z.string().datetime(),
  impersonatedUser: adminUserResponseSchema,
  mode: z.literal("view"),
});

interface AdminUsersRoutesOptions {
  readonly service: AdminUsersService;
  readonly env: Env;
}

export async function adminUsersRoutes(
  app: FastifyInstance,
  opts: AdminUsersRoutesOptions
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  const { service, env } = opts;

  route.addHook("preHandler", app.requireAdmin);

  const cookieCfg = {
    secure: env.COOKIE_SECURE,
    domain: env.COOKIE_DOMAIN,
    maxAgeSeconds: env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60,
  };

  // H2: access-cookie config matches auth.routes.ts. Capped at 24h
  // because cookies live on `/api/v1/upstream` and are used by viem
  // (which has no refresh logic of its own) — past 24h the cookie
  // forces a fresh login.
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

  route.get(
    "/",
    {
      schema: {
        querystring: listFilterSchema,
        response: { 200: adminUserListResponseSchema },
      },
    },
    async (req) => {
      const filter: {
        status?: "active" | "pending" | "blocked";
        role?: "admin" | "user" | "viewer";
        search?: string;
        cursor?: string;
        limit?: number;
      } = {};
      if (req.query.status) filter.status = req.query.status;
      if (req.query.role) filter.role = req.query.role;
      if (req.query.search) filter.search = req.query.search;
      if (req.query.cursor) filter.cursor = req.query.cursor;
      if (req.query.limit) filter.limit = req.query.limit;

      const page = await service.listUsers(filter);
      return {
        items: page.items.map((entry) => ({
          ...toAdminUserResponse(entry.user),
          accountCount: entry.accountCount,
          lastSnapshotAt: entry.lastSnapshotAt
            ? entry.lastSnapshotAt.toISOString()
            : null,
          lastSnapshotUsd: entry.lastSnapshotUsd,
        })),
        nextCursor: page.nextCursor,
      };
    }
  );

  route.patch(
    "/:id/status",
    {
      schema: {
        params: userIdParamSchema,
        body: setStatusBodySchema,
        response: { 200: adminUserResponseSchema },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const updated = await service.setStatus(
        req.params.id,
        req.body.status,
        u.id
      );
      return toAdminUserResponse(updated);
    }
  );

  route.patch(
    "/:id/role",
    {
      schema: {
        params: userIdParamSchema,
        body: setRoleBodySchema,
        response: { 200: adminUserResponseSchema },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const updated = await service.setRole(req.params.id, req.body.role, u.id);
      return toAdminUserResponse(updated);
    }
  );

  /**
   * Hard-delete user and ALL associated data.
   *
   * Destructive: removes accounts (cascades wallets/operations/snapshots),
   * sessions, payments, notifications. Cannot delete yourself, and the
   * last admin is protected by the service-layer guard.
   *
   * `audit_log` retains the row but nulls out actor/target FKs — useful
   * for forensic queries about who-deleted-whom-and-when.
   */
  route.delete(
    "/:id",
    {
      schema: {
        params: userIdParamSchema,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      await service.deleteUser(req.params.id, u.id);
      return reply.status(204).send(null);
    }
  );

  route.post(
    "/:id/impersonate",
    {
      schema: {
        params: userIdParamSchema,
        response: { 200: impersonateResponseSchema },
      },
    },
    async (req, reply) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const result = await service.impersonate({
        adminId: u.id,
        targetUserId: req.params.id,
        userAgent: req.headers["user-agent"] ?? null,
        ip: req.ip ?? null,
      });
      setRefreshCookie(reply, result.refreshToken, cookieCfg);
      // H2: also re-issue the access cookie. Previously only the refresh
      // cookie was rotated, leaving the admin's `cap_access` cookie in
      // the browser. Subsequent upstream-proxy calls (viem to Alchemy,
      // DeBank) authenticated AS THE ADMIN, not as the impersonated
      // user — broken rate-limit attribution and (worse) potential
      // data leaks across tenants if any handler scoped by cookie
      // identity. Setting the new access cookie aligns both auth
      // paths and the JS-readable bearer token to the same identity.
      setAccessCookie(reply, result.accessToken, accessCookieCfg);
      // Rotate CSRF too — the new identity must not share the admin's
      // pre-impersonation CSRF token, otherwise a request that the
      // admin had prepared could be replayed as the impersonated user.
      setCsrfCookie(reply, generateCsrfToken(), csrfCookieCfg);
      return {
        accessToken: result.accessToken,
        expiresAt: result.accessTokenExpiresAt.toISOString(),
        impersonatedUser: toAdminUserResponse(result.impersonatedUser),
        mode: "view" as const,
      };
    }
  );

  // NB: DELETE /:id/impersonate is intentionally NOT registered in this
  // admin-scoped router — the impersonated user (role=user) can't pass
  // the requireAdmin hook above, but they're the one whose dashboard
  // shows the "Завершить" button.  The end-impersonation endpoint lives
  // in apps/api/src/modules/auth (registered separately, requireAuth
  // only) and identifies the admin via session.impersonatedById.
}

function toAdminUserResponse(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role as "admin" | "user" | "viewer",
    status: u.status as "active" | "pending" | "blocked",
    createdAt: u.createdAt.toISOString(),
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
  };
}

void REFRESH_COOKIE_NAME;
