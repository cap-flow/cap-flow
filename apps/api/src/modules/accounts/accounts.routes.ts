import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { UnauthorizedError } from "../../core/errors.js";

import {
  accountIdParamSchema,
  accountListResponseSchema,
  accountResponseSchema,
  createAccountBodySchema,
  updateAccountBodySchema,
} from "./accounts.schema.js";
import type { AccountRow } from "./accounts.repository.js";
import type { AccountsService } from "./accounts.service.js";

interface AccountRoutesOptions {
  readonly accounts: AccountsService;
}

export async function accountsRoutes(
  app: FastifyInstance,
  opts: AccountRoutesOptions
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  const { accounts } = opts;

  // All endpoints under this prefix require an authenticated session.
  route.addHook("preHandler", app.requireAuth);

  route.get(
    "/",
    { schema: { response: { 200: accountListResponseSchema } } },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const rows = await accounts.listForCurrentUser(u);
      return rows.map(toResponse);
    }
  );

  route.post(
    "/",
    {
      schema: {
        body: createAccountBodySchema,
        response: { 201: accountResponseSchema },
      },
    },
    async (req, reply) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const row = await accounts.create(
        { name: req.body.name, description: req.body.description ?? null },
        u
      );
      return reply.status(201).send(toResponse(row));
    }
  );

  route.get(
    "/:id",
    {
      schema: {
        params: accountIdParamSchema,
        response: { 200: accountResponseSchema },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const row = await accounts.getById(req.params.id, u);
      return toResponse(row);
    }
  );

  route.patch(
    "/:id",
    {
      schema: {
        params: accountIdParamSchema,
        body: updateAccountBodySchema,
        response: { 200: accountResponseSchema },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const row = await accounts.update(req.params.id, req.body, u);
      return toResponse(row);
    }
  );

  route.delete(
    "/:id",
    {
      schema: {
        params: accountIdParamSchema,
        response: { 200: accountResponseSchema },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const row = await accounts.archive(req.params.id, u);
      return toResponse(row);
    }
  );
}

function toResponse(row: AccountRow) {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    description: row.description,
    isPrimary: row.isPrimary,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
