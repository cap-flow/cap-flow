import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { AdminPortfoliosService } from "./admin-portfolios.service.js";

const accountRowSchema = z.object({
  accountId: z.string().uuid(),
  accountName: z.string(),
  ownerId: z.string().uuid(),
  ownerEmail: z.string().nullable(),
  ownerName: z.string().nullable(),
  isPrimary: z.boolean(),
  lastSnapshotAt: z.string().datetime().nullable(),
  lastSnapshotUsd: z.number().nullable(),
  lastTrigger: z.string().nullable(),
  snapshotCount24h: z.number(),
  errors24h: z.number(),
});

const aggregateSchema = z.object({
  accountsActive: z.number(),
  usersActive: z.number(),
  totalUsd: z.number(),
  snapshotsLast24h: z.number(),
  errorsLast24h: z.number(),
});

interface AdminPortfoliosRoutesOptions {
  readonly service: AdminPortfoliosService;
}

export async function adminPortfoliosRoutes(
  app: FastifyInstance,
  opts: AdminPortfoliosRoutesOptions
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAdmin);

  route.get(
    "/",
    { schema: { response: { 200: z.array(accountRowSchema) } } },
    async () => {
      const rows = await opts.service.listAllAccounts();
      return rows.map((r) => ({
        accountId: r.accountId,
        accountName: r.accountName,
        ownerId: r.ownerId,
        ownerEmail: r.ownerEmail,
        ownerName: r.ownerName,
        isPrimary: r.isPrimary,
        // `r.lastSnapshotAt` comes from a raw subquery (`sql<Date | null>`),
        // which Drizzle returns as a string in PG. Re-construct Date so the
        // ISO conversion is consistent with other endpoints.
        lastSnapshotAt: r.lastSnapshotAt
          ? new Date(r.lastSnapshotAt).toISOString()
          : null,
        lastSnapshotUsd: r.lastSnapshotUsd,
        lastTrigger: r.lastTrigger,
        snapshotCount24h: r.snapshotCount24h,
        errors24h: r.errors24h,
      }));
    }
  );

  route.get(
    "/aggregate",
    { schema: { response: { 200: aggregateSchema } } },
    async () => opts.service.aggregate()
  );
}
