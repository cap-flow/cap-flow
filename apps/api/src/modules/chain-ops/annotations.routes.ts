/**
 * UCB A3: REST endpoints для per-op annotations.
 *
 *   PUT    /v1/chain-ops/annotations/:opId  — upsert annotation
 *   DELETE /v1/chain-ops/annotations/:opId  — remove annotation
 *   GET    /v1/chain-ops/annotations         — list ВСЕХ annotations user'а
 *
 * Все endpoints check ownership через service-layer (`ensureOwnership`).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { UnauthorizedError } from "../../core/errors.js";

import type { AnnotationsService } from "./annotations.service.js";

interface RouteOptions {
  readonly service: AnnotationsService;
}

const opIdParam = z.object({ opId: z.string().uuid() });

const upsertBody = z.object({
  // Three-valued: true | false | null (last = "no override").
  isInternalTransfer: z.boolean().nullable(),
  manualCostBasisUsd: z.number().nonnegative().nullable(),
  manualOpType: z.string().min(1).max(40).nullable(),
  note: z.string().max(2000).nullable(),
  // UCB D8: optional with default false для backward compat — старые
  // клиенты могут не присылать поле.
  excluded: z.boolean().optional().default(false),
});

const annotationResponse = z.object({
  id: z.string().uuid(),
  chainOpId: z.string().uuid(),
  userId: z.string().uuid(),
  isInternalTransfer: z.boolean().nullable(),
  manualCostBasisUsd: z.number().nullable(),
  manualOpType: z.string().nullable(),
  note: z.string().nullable(),
  excluded: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const resolvedAnnotationResponse = annotationResponse.extend({
  txHash: z.string(),
  walletId: z.string().uuid(),
  logIndex: z.number().int(),
});

const listResponse = z.object({
  annotations: z.array(resolvedAnnotationResponse),
});

export async function annotationsRoutes(
  app: FastifyInstance,
  opts: RouteOptions,
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAuth);

  // Helper для row → response: numeric column из БД приходит как string,
  // конвертим обратно в number для wire-format.
  const toResponse = (r: {
    id: string;
    chainOpId: string;
    userId: string;
    isInternalTransfer: boolean | null;
    manualCostBasisUsd: string | null;
    manualOpType: string | null;
    note: string | null;
    excluded: boolean;
    createdAt: Date;
    updatedAt: Date;
  }) => ({
    id: r.id,
    chainOpId: r.chainOpId,
    userId: r.userId,
    isInternalTransfer: r.isInternalTransfer,
    manualCostBasisUsd:
      r.manualCostBasisUsd != null ? Number(r.manualCostBasisUsd) : null,
    manualOpType: r.manualOpType,
    note: r.note,
    excluded: r.excluded,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  });

  route.put(
    "/:opId",
    {
      schema: {
        params: opIdParam,
        body: upsertBody,
        response: { 200: annotationResponse },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const row = await opts.service.upsert(req.params.opId, u.id, {
        isInternalTransfer: req.body.isInternalTransfer,
        manualCostBasisUsd: req.body.manualCostBasisUsd,
        manualOpType: req.body.manualOpType,
        note: req.body.note,
        excluded: req.body.excluded,
      });
      return toResponse(row);
    },
  );

  // Composite-key upsert — first-create flow когда client ещё не знает
  // chain_operations.id (op только что синканся, аннотаций нет в кэше).
  route.put(
    "/by-key",
    {
      schema: {
        body: upsertBody.extend({
          walletId: z.string().uuid(),
          txHash: z.string().min(2).max(120),
          logIndex: z.number().int().nonnegative(),
        }),
        response: { 200: annotationResponse },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const row = await opts.service.upsertByKey(
        req.body.walletId,
        req.body.txHash,
        req.body.logIndex,
        u.id,
        {
          isInternalTransfer: req.body.isInternalTransfer,
          manualCostBasisUsd: req.body.manualCostBasisUsd,
          manualOpType: req.body.manualOpType,
          note: req.body.note,
          excluded: req.body.excluded,
        },
      );
      return toResponse(row);
    },
  );

  route.delete(
    "/:opId",
    {
      schema: {
        params: opIdParam,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      await opts.service.delete(req.params.opId, u.id);
      reply.code(204).send(null);
    },
  );

  route.get(
    "/",
    {
      schema: {
        response: { 200: listResponse },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const rows = await opts.service.listAll(u.id);
      return {
        annotations: rows.map((r) => ({
          ...toResponse(r),
          txHash: r.txHash,
          walletId: r.walletId,
          logIndex: r.logIndex,
        })),
      };
    },
  );
}
