import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { UnauthorizedError } from "../../core/errors.js";

import type { InviteRow } from "./invites.repository.js";
import {
  createInviteBodySchema,
  inviteAdminResponseSchema,
  inviteCreatedResponseSchema,
  inviteIdParamSchema,
  inviteListResponseSchema,
  listInvitesQuerySchema,
} from "./invites.schema.js";
import type { InvitesService } from "./invites.service.js";

interface AdminInviteRoutesOptions {
  readonly invites: InvitesService;
}

export async function adminInviteRoutes(
  app: FastifyInstance,
  opts: AdminInviteRoutesOptions
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  const { invites } = opts;

  // Every endpoint here requires an admin session.
  route.addHook("preHandler", app.requireAdmin);

  route.post(
    "/",
    {
      schema: {
        body: createInviteBodySchema,
        response: { 201: inviteCreatedResponseSchema },
      },
    },
    async (req, reply) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const created = await invites.createInvite({
        email: req.body.email,
        ttlHours: req.body.ttlHours,
        notes: req.body.notes,
        createdByUserId: u.id,
      });
      return reply.status(201).send({
        ...toAdminResponse(created.invite),
        token: created.rawToken,
        inviteUrl: created.inviteUrl,
      });
    }
  );

  route.get(
    "/",
    {
      schema: {
        querystring: listInvitesQuerySchema,
        response: { 200: inviteListResponseSchema },
      },
    },
    async (req) => {
      const rows = await invites.listInvites({ status: req.query.status });
      return rows.map(toAdminResponse);
    }
  );

  route.delete(
    "/:id",
    {
      schema: {
        params: inviteIdParamSchema,
        response: { 200: inviteAdminResponseSchema },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const row = await invites.revokeInvite(req.params.id, u.id);
      return toAdminResponse(row);
    }
  );
}

function toAdminResponse(row: InviteRow) {
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    consumedAt: row.consumedAt ? row.consumedAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    notes: row.notes,
  };
}
