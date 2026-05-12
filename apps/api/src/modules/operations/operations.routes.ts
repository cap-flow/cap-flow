import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { UnauthorizedError } from "../../core/errors.js";

import type { OperationRow } from "./operations.repository.js";
import type { OperationsService } from "./operations.service.js";

const accountIdParam = z.object({ id: z.string().uuid() });
const operationIdParam = z.object({
  id: z.string().uuid(),
  opid: z.string().uuid(),
});

const opTypeEnum = z.enum([
  "buy",
  "sell",
  "swap",
  "transfer",
  "deposit",
  "withdraw",
  "fee",
  "open",
  "close",
  "loan",
  "loan_repay",
  "loan_take",
  "div",
  "other",
]);
const opSourceEnum = z.enum(["manual", "import", "promoted"]);
const fundsKindEnum = z.enum(["own", "loan"]);

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const numericString = z.string().regex(/^-?\d+(\.\d+)?$/, "expected numeric");

const importItem = z.object({
  legacyId: z.string().min(1).max(120),
  date: dateOnly,
  type: opTypeEnum,
  source: opSourceEnum.optional(),
  fromName: z.string().max(200).nullable().optional(),
  toName: z.string().max(200).nullable().optional(),
  cur1: z.string().max(60).nullable().optional(),
  amount1: numericString.nullable().optional(),
  cur2: z.string().max(60).nullable().optional(),
  amount2: numericString.nullable().optional(),
  rate: numericString.nullable().optional(),
  avgPrice: numericString.nullable().optional(),
  priceUsd: numericString.nullable().optional(),
  posType: z.string().max(60).nullable().optional(),
  funds: fundsKindEnum.nullable().optional(),
  loanRate: numericString.nullable().optional(),
  loanRateTake: numericString.nullable().optional(),
  loanFromName: z.string().max(200).nullable().optional(),
  loanPosLegacyId: z.string().max(120).nullable().optional(),
  loanLtv: numericString.nullable().optional(),
  loanLiqPct: numericString.nullable().optional(),
  loanLiqPrice: numericString.nullable().optional(),
  loanCollateralUsd: numericString.nullable().optional(),
  network: z.string().max(60).nullable().optional(),
  commissionNetwork: z.string().max(60).nullable().optional(),
  closeTokenAmount: numericString.nullable().optional(),
  direction: z.string().max(60).nullable().optional(),
  comment: z.string().max(2000).optional(),
});

const importBody = z.object({
  items: z.array(importItem).min(1).max(5000),
});

const importResponse = z.object({
  inserted: z.number().int(),
  updated: z.number().int(),
  total: z.number().int(),
});

const operationResponse = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  legacyId: z.string(),
  date: z.string(),
  type: opTypeEnum,
  source: opSourceEnum,
  fromName: z.string().nullable(),
  toName: z.string().nullable(),
  cur1: z.string().nullable(),
  amount1: z.string().nullable(),
  cur2: z.string().nullable(),
  amount2: z.string().nullable(),
  rate: z.string().nullable(),
  avgPrice: z.string().nullable(),
  priceUsd: z.string().nullable(),
  posType: z.string().nullable(),
  funds: fundsKindEnum.nullable(),
  loanRate: z.string().nullable(),
  loanRateTake: z.string().nullable(),
  loanFromName: z.string().nullable(),
  loanPosLegacyId: z.string().nullable(),
  loanLtv: z.string().nullable(),
  loanLiqPct: z.string().nullable(),
  loanLiqPrice: z.string().nullable(),
  loanCollateralUsd: z.string().nullable(),
  network: z.string().nullable(),
  commissionNetwork: z.string().nullable(),
  closeTokenAmount: z.string().nullable(),
  direction: z.string().nullable(),
  comment: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const listQuery = z.object({
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  limit: z.coerce.number().int().positive().max(5000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

interface OperationsRoutesOptions {
  readonly service: OperationsService;
}

export async function operationsRoutes(
  app: FastifyInstance,
  opts: OperationsRoutesOptions
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAuth);

  route.get(
    "/:id/operations",
    {
      schema: {
        params: accountIdParam,
        querystring: listQuery,
        response: { 200: z.array(operationResponse) },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const rows = await opts.service.list(req.params.id, u, req.query);
      return rows.map(toOperationResponse);
    }
  );

  route.get(
    "/:id/operations/stats",
    {
      schema: {
        params: accountIdParam,
        response: {
          200: z.object({
            count: z.number().int(),
            lastUpdatedAt: z.string().datetime().nullable(),
          }),
        },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const s = await opts.service.stats(req.params.id, u);
      return {
        count: s.count,
        lastUpdatedAt: s.lastUpdatedAt ? s.lastUpdatedAt.toISOString() : null,
      };
    }
  );

  route.post(
    "/:id/operations/import",
    {
      schema: {
        params: accountIdParam,
        body: importBody,
        response: { 200: importResponse },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      return opts.service.importBatch(req.params.id, req.body.items, u);
    }
  );

  route.delete(
    "/:id/operations/:opid",
    { schema: { params: operationIdParam } },
    async (req, reply) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      await opts.service.deleteOne(req.params.id, req.params.opid, u);
      return reply.status(204).send();
    }
  );
}

function toOperationResponse(row: OperationRow) {
  return {
    id: row.id,
    accountId: row.accountId,
    legacyId: row.legacyId,
    date: row.date,
    type: row.type,
    source: row.source,
    fromName: row.fromName,
    toName: row.toName,
    cur1: row.cur1,
    amount1: row.amount1,
    cur2: row.cur2,
    amount2: row.amount2,
    rate: row.rate,
    avgPrice: row.avgPrice,
    priceUsd: row.priceUsd,
    posType: row.posType,
    funds: row.funds,
    loanRate: row.loanRate,
    loanRateTake: row.loanRateTake,
    loanFromName: row.loanFromName,
    loanPosLegacyId: row.loanPosLegacyId,
    loanLtv: row.loanLtv,
    loanLiqPct: row.loanLiqPct,
    loanLiqPrice: row.loanLiqPrice,
    loanCollateralUsd: row.loanCollateralUsd,
    network: row.network,
    commissionNetwork: row.commissionNetwork,
    closeTokenAmount: row.closeTokenAmount,
    direction: row.direction,
    comment: row.comment,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
