/**
 * UCB B4: REST endpoint для sync coverage UI.
 *
 *   GET /v1/sync-coverage → snapshot всех wallets + CEX accounts с
 *   last_sync timestamps, errors, counts.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { UnauthorizedError } from "../../core/errors.js";

import type { SyncCoverageService } from "./sync-coverage.service.js";

interface RouteOptions {
  readonly service: SyncCoverageService;
}

const walletCoverage = z.object({
  id: z.string().uuid(),
  name: z.string(),
  kind: z.string(),
  lastSyncAt: z.string().datetime().nullable(),
  lastSyncError: z.string().nullable(),
  opsCount: z.number().int().nonnegative(),
});

const cexAccountCoverage = z.object({
  id: z.string().uuid(),
  exchange: z.string(),
  label: z.string().nullable(),
  lastSyncAt: z.string().datetime().nullable(),
  lastSyncError: z.string().nullable(),
  lastTradesSyncAt: z.string().datetime().nullable(),
  lastTradesSyncError: z.string().nullable(),
  lastInternalTransfersSyncAt: z.string().datetime().nullable(),
  lastInternalTransfersSyncError: z.string().nullable(),
  tradesCount: z.number().int().nonnegative(),
  transfersCount: z.number().int().nonnegative(),
  internalTransfersCount: z.number().int().nonnegative(),
  p2pCount: z.number().int().nonnegative(),
});

const coverageResponse = z.object({
  wallets: z.array(walletCoverage),
  cexAccounts: z.array(cexAccountCoverage),
});

export async function syncCoverageRoutes(
  app: FastifyInstance,
  opts: RouteOptions,
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAuth);

  route.get(
    "/",
    {
      schema: {
        response: { 200: coverageResponse },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const c = await opts.service.getCoverage(u.id);
      return {
        wallets: c.wallets.map((w) => ({
          id: w.id,
          name: w.name,
          kind: w.kind,
          lastSyncAt: w.lastSyncAt ? w.lastSyncAt.toISOString() : null,
          lastSyncError: w.lastSyncError,
          opsCount: w.opsCount,
        })),
        cexAccounts: c.cexAccounts.map((a) => ({
          id: a.id,
          exchange: a.exchange,
          label: a.label,
          lastSyncAt: a.lastSyncAt ? a.lastSyncAt.toISOString() : null,
          lastSyncError: a.lastSyncError,
          lastTradesSyncAt: a.lastTradesSyncAt
            ? a.lastTradesSyncAt.toISOString()
            : null,
          lastTradesSyncError: a.lastTradesSyncError,
          lastInternalTransfersSyncAt: a.lastInternalTransfersSyncAt
            ? a.lastInternalTransfersSyncAt.toISOString()
            : null,
          lastInternalTransfersSyncError: a.lastInternalTransfersSyncError,
          tradesCount: a.tradesCount,
          transfersCount: a.transfersCount,
          internalTransfersCount: a.internalTransfersCount,
          p2pCount: a.p2pCount,
        })),
      };
    },
  );
}
