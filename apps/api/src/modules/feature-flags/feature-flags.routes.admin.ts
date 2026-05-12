import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { UnauthorizedError } from "../../core/errors.js";

import type { FeatureFlagsService } from "./feature-flags.service.js";

const scopeEnum = z.enum(["global", "account", "user"]);

const idParam = z.object({ id: z.string().uuid() });
const keyParam = z.object({ key: z.string().min(1).max(80) });

const upsertBodySchema = z
  .object({
    scope: scopeEnum,
    scopeRefId: z.string().uuid().nullable(),
    enabled: z.boolean(),
    payload: z.record(z.unknown()).nullable().optional(),
  })
  .refine(
    (b) =>
      (b.scope === "global" && b.scopeRefId === null) ||
      (b.scope !== "global" && b.scopeRefId !== null),
    {
      message:
        "scopeRefId must be null for 'global' and non-null for 'account' / 'user'",
      path: ["scopeRefId"],
    }
  );

const flagResponseSchema = z.object({
  id: z.string().uuid(),
  key: z.string(),
  scope: scopeEnum,
  scopeRefId: z.string().uuid().nullable(),
  enabled: z.boolean(),
  payload: z.unknown().nullable(),
  updatedAt: z.string().datetime(),
});

interface AdminFeatureFlagsRoutesOptions {
  readonly service: FeatureFlagsService;
}

export async function adminFeatureFlagsRoutes(
  app: FastifyInstance,
  opts: AdminFeatureFlagsRoutesOptions
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAdmin);

  route.get(
    "/",
    { schema: { response: { 200: z.array(flagResponseSchema) } } },
    async () => {
      const rows = await opts.service.listAll();
      return rows.map(toResponse);
    }
  );

  route.get(
    "/:key",
    {
      schema: {
        params: keyParam,
        response: { 200: z.array(flagResponseSchema) },
      },
    },
    async (req) => {
      const rows = await opts.service.listByKey(req.params.key);
      return rows.map(toResponse);
    }
  );

  route.put(
    "/:key",
    {
      schema: {
        params: keyParam,
        body: upsertBodySchema,
        response: { 200: flagResponseSchema },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const row = await opts.service.upsert(
        {
          key: req.params.key,
          scope: req.body.scope,
          scopeRefId: req.body.scopeRefId,
          enabled: req.body.enabled,
          payload: req.body.payload ?? null,
        },
        u.id
      );
      return toResponse(row);
    }
  );

  route.delete(
    "/:id",
    {
      schema: {
        params: idParam,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      await opts.service.deleteById(req.params.id, u.id);
      return reply.status(204).send(null);
    }
  );
}

function toResponse(row: {
  id: string;
  key: string;
  scope: string;
  scopeRefId: string | null;
  enabled: boolean;
  payload: unknown;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    key: row.key,
    scope: row.scope as "global" | "account" | "user",
    scopeRefId: row.scopeRefId,
    enabled: row.enabled,
    payload: row.payload ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}
