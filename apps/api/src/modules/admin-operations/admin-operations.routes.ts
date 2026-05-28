import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { AdminOperationsService } from "./admin-operations.service.js";

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const listQuery = z.object({
  userId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  walletId: z.string().uuid().optional(),
  // op_type / chain are free-form text (machine-classified), not a fixed enum.
  type: z.string().max(60).optional(),
  chain: z.string().max(60).optional(),
  status: z.string().max(40).optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const movementSchema = z.object({
  symbol: z.string(),
  amount: z.number(),
  usd: z.number().nullable(),
  direction: z.enum(["in", "out"]),
});

const operationRowSchema = z.object({
  id: z.string().uuid(),
  walletId: z.string().uuid(),
  walletName: z.string(),
  accountId: z.string().uuid(),
  accountName: z.string(),
  ownerId: z.string().uuid(),
  ownerEmail: z.string().nullable(),
  ownerName: z.string().nullable(),
  opTime: z.string().datetime(),
  opType: z.string(),
  chain: z.string(),
  status: z.string(),
  txHash: z.string(),
  protocol: z.string().nullable(),
  counterparty: z.string().nullable(),
  netUsd: z.number().nullable(),
  gasUsd: z.number().nullable(),
  movements: z.array(movementSchema),
  notes: z.array(z.string()),
  createdAt: z.string().datetime(),
});

const listResponse = z.object({
  items: z.array(operationRowSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});

const facetsResponse = z.object({
  chains: z.array(z.string()),
  opTypes: z.array(z.string()),
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
        walletId: q.walletId,
        opType: q.type,
        chain: q.chain,
        status: q.status,
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
