import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { Env } from "../../config/env.js";
import { UnauthorizedError } from "../../core/errors.js";
import {
  REFRESH_COOKIE_NAME,
  setRefreshCookie,
} from "../auth/auth.cookies.js";
import type { UserRow } from "../auth/auth.repository.js";

import type { AdminUsersService } from "./admin-users.service.js";

const userIdParamSchema = z.object({ id: z.string().uuid() });

const listFilterSchema = z.object({
  status: z.enum(["active", "pending", "blocked"]).optional(),
  role: z.enum(["admin", "user", "viewer"]).optional(),
  search: z.string().max(120).optional(),
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

const adminUserListResponseSchema = z.array(adminUserWithAggregatesSchema);

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
      } = {};
      if (req.query.status) filter.status = req.query.status;
      if (req.query.role) filter.role = req.query.role;
      if (req.query.search) filter.search = req.query.search;

      const rows = await service.listUsers(filter);
      return rows.map((entry) => ({
        ...toAdminUserResponse(entry.user),
        accountCount: entry.accountCount,
        lastSnapshotAt: entry.lastSnapshotAt
          ? entry.lastSnapshotAt.toISOString()
          : null,
        lastSnapshotUsd: entry.lastSnapshotUsd,
      }));
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
