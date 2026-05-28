import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { AdminOperationsService } from "./admin-operations.service.js";

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

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const listQuery = z.object({
  userId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  type: opTypeEnum.optional(),
  network: z.string().max(60).optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const operationRowSchema = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  accountName: z.string(),
  ownerId: z.string().uuid(),
  ownerEmail: z.string().nullable(),
  ownerName: z.string().nullable(),
  date: z.string(),
  type: opTypeEnum,
  source: z.string(),
  fromName: z.string().nullable(),
  toName: z.string().nullable(),
  cur1: z.string().nullable(),
  amount1: z.string().nullable(),
  cur2: z.string().nullable(),
  amount2: z.string().nullable(),
  priceUsd: z.string().nullable(),
  network: z.string().nullable(),
  comment: z.string(),
  createdAt: z.string().datetime(),
});

const listResponse = z.object({
  items: z.array(operationRowSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});

const facetsResponse = z.object({
  networks: z.array(z.string()),
});

interface AdminOperationsRoutesOptions {
  readonly service: AdminOperationsService;
}

export async function adminOperationsRoutes(
  app: FastifyInstance,
  opts: AdminOperationsRoutesOptions
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAdmin);

  route.get(
    "/",
    { schema: { querystring: listQuery, response: { 200: listResponse } } },
    async (req) => {
      const q = req.query;
      const page = await opts.service.list({
        userId: q.userId,
        accountId: q.accountId,
        type: q.type,
        network: q.network,
        from: q.from,
        to: q.to,
        search: q.search,
        limit: q.limit ?? 100,
        offset: q.offset ?? 0,
      });
      return {
        items: page.items.map((r) => ({
          ...r,
          createdAt: r.createdAt.toISOString(),
        })),
        total: page.total,
        limit: page.limit,
        offset: page.offset,
      };
    }
  );

  route.get(
    "/facets",
    { schema: { response: { 200: facetsResponse } } },
    async () => opts.service.facets()
  );
}
