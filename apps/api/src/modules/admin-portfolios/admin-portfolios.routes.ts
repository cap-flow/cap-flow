import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { UnauthorizedError } from "../../core/errors.js";
import type { PortfolioRefreshQueue } from "../queue/portfolio-refresh.queue.js";

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
  readonly refreshQueue: PortfolioRefreshQueue;
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

  /**
   * Bulk refresh — enqueues a manual refresh job for every active account.
   * Admin-only. The UI "Обновить" button on /admin/portfolios calls this,
   * then refetches the list/aggregate so admin sees the updated snapshot
   * (typically within 30-60 sec depending on DeBank latency).
   *
   * Returns `{ enqueued: N }` so the UI can show a confirmation.
   */
  route.post(
    "/refresh-all",
    {
      schema: {
        response: {
          200: z.object({
            enqueued: z.number(),
            accountIds: z.array(z.string().uuid()),
          }),
        },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const rows = await opts.service.listAllAccounts();
      const ids: string[] = [];
      for (const r of rows) {
        await opts.refreshQueue.enqueueManual(r.accountId, u.id, "admin");
        ids.push(r.accountId);
      }
      return { enqueued: ids.length, accountIds: ids };
    }
  );

  /**
   * Refresh one account by id. Admin-only; bypasses the per-IP rate-limit
   * on the user-facing /portfolios/:id/refresh.
   */
  route.post(
    "/:id/refresh",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          202: z.object({ jobId: z.string(), accountId: z.string().uuid() }),
        },
      },
    },
    async (req, reply) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const jobId = await opts.refreshQueue.enqueueManual(
        req.params.id,
        u.id,
        "admin"
      );
      return reply.status(202).send({ jobId, accountId: req.params.id });
    }
  );
}
