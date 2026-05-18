import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { UnauthorizedError } from "../../core/errors.js";

import type { ChainOpsService } from "./chain-ops.service.js";

/**
 * UCB B5.2: REST endpoints для server-side on-chain ops cache.
 *
 *   POST /v1/chain-ops/:walletId/sync — bulk push classified ops от клиента
 *   GET  /v1/chain-ops/:walletId      — read cached ops для cost-basis recompute
 *   GET  /v1/chain-ops/:walletId/status — sync state (latest_op_time, count)
 *
 * Все endpoints проверяют ownership wallet → user через
 * `walletBelongsToUser`.
 */
interface RouteOptions {
  readonly service: ChainOpsService;
}

const walletIdParam = z.object({ walletId: z.string().uuid() });

const opInput = z.object({
  chain: z.string().min(1).max(20),
  txHash: z.string().min(2).max(120),
  logIndex: z.number().int().nonnegative().optional(),
  opType: z.string().min(1).max(40),
  opTime: z.number().int().positive(), // unix seconds
  status: z.string().max(40),
  // `z.unknown()` делает поле optional в derived type; используем
  // `z.any()` чтобы remained required-but-any.
  raw: z.any(),
});

const syncBatchBody = z.object({
  ops: z.array(opInput).max(10_000),
});

const syncBatchResponse = z.object({
  inserted: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

const opResponse = z.object({
  id: z.string().uuid(),
  walletId: z.string().uuid(),
  chain: z.string(),
  txHash: z.string(),
  logIndex: z.number().int(),
  opType: z.string(),
  opTime: z.string().datetime(),
  status: z.string(),
  raw: z.unknown(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const listResponse = z.array(opResponse);

const statusResponse = z.object({
  walletId: z.string().uuid(),
  latestOpTime: z.string().datetime().nullable(),
  opsCount: z.number().int().nonnegative(),
});

const graphInternalTransferItem = z.object({
  txHash: z.string(),
  chain: z.string(),
  opTime: z.string().datetime(),
  outWalletId: z.string().uuid(),
  outOpType: z.string(),
  outRaw: z.unknown(),
  inWalletId: z.string().uuid(),
  inOpType: z.string(),
  inRaw: z.unknown(),
});
const graphCrossChainPair = z.object({
  outTxHash: z.string(),
  inTxHash: z.string(),
  outChain: z.string(),
  inChain: z.string(),
  outWalletId: z.string().uuid(),
  inWalletId: z.string().uuid(),
  symbol: z.string(),
  outAmount: z.number(),
  inAmount: z.number(),
  feeUsd: z.number(),
  outRaw: z.unknown(),
  inRaw: z.unknown(),
});
// UCB A5: A→B→A self-bridge cycle.
const graphSelfBridgeCycle = z.object({
  originWalletId: z.string().uuid(),
  hopWalletId: z.string().uuid(),
  family: z.string(),
  legA: graphCrossChainPair,
  legB: graphCrossChainPair,
  totalFeeUsd: z.number(),
  durationSec: z.number(),
});

// Bob-test #4: untracked withdrawal destination (CEX → unknown address).
const graphUntrackedDestination = z.object({
  txHash: z.string(),
  asset: z.string(),
  amount: z.number(),
  exchange: z.string(),
  executedAt: z.string().datetime(),
});

// UCB A5.2: multi-hop cycle (N legs).
const graphMultiHopCycle = z.object({
  originWalletId: z.string().uuid(),
  walletPath: z.array(z.string().uuid()),
  legs: z.array(graphCrossChainPair),
  totalFeeUsd: z.number(),
  durationSec: z.number(),
  families: z.array(z.string()),
});

// UCB C2: CEX A → wallet → CEX B hop chain.
const graphCexHopChain = z.object({
  walletId: z.string().uuid(),
  family: z.string(),
  fromCex: z.object({
    cexAccountId: z.string().uuid(),
    cexExchange: z.string(),
  }),
  toCex: z.object({
    cexAccountId: z.string().uuid(),
    cexExchange: z.string(),
  }),
  inboundTxHash: z.string(),
  outboundTxHash: z.string(),
  inboundChain: z.string(),
  outboundChain: z.string(),
  inboundAmount: z.number(),
  outboundAmount: z.number(),
  inboundTimeSec: z.number(),
  outboundTimeSec: z.number(),
  durationSec: z.number(),
});
const graphInternalTransfersResponse = z.object({
  pairs: z.array(graphInternalTransferItem),
  crossChainPairs: z.array(graphCrossChainPair),
  /** UCB A5: optional — older clients ignore. */
  selfBridgeCycles: z.array(graphSelfBridgeCycle).optional(),
  /** UCB C2: optional — CEX A → wallet → CEX B chains. */
  cexHopChains: z.array(graphCexHopChain).optional(),
  /** UCB A5.2: optional — N-leg multi-hop cycles. */
  multiHopCycles: z.array(graphMultiHopCycle).optional(),
  /** Bob-test #4: optional — CEX withdrawals без on-chain match. */
  untrackedDestinations: z.array(graphUntrackedDestination).optional(),
});

/**
 * Security-hardening (2026-05-18): `POST /:walletId/sync` accepts up to
 * 10 000 classified ops in a single batch and triggers a CTE-heavy
 * insert + cost-basis recompute. Cap at 5 req/min per user — far above
 * normal post-Refresh sync cadence (~1 req per wallet per minute) but
 * blocks both runaway clients and intentional DB-storm attempts.
 *
 * `hook: "preHandler"` re-binds the limiter to run after auth, so
 * `req.user.id` is set when keyGenerator fires (see cex.routes.ts for
 * the long-form rationale).
 */
const HEAVY_SYNC_LIMIT = {
  max: 5,
  timeWindow: "1 minute",
  hook: "preHandler",
  keyGenerator: (req: { user?: { id: string }; ip?: string }) =>
    req.user?.id ?? req.ip ?? "anon",
} as const;

export async function chainOpsRoutes(
  app: FastifyInstance,
  opts: RouteOptions,
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAuth);

  route.post(
    "/:walletId/sync",
    {
      schema: {
        params: walletIdParam,
        body: syncBatchBody,
        response: { 200: syncBatchResponse },
      },
      config: { rateLimit: HEAVY_SYNC_LIMIT },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      // Zod выдаёт mutable array — кастуем к readonly через `as` (наш
      // service-contract immutable, но runtime ничего не мутирует).
      return opts.service.syncBatch(
        req.params.walletId,
        u.id,
        req.body.ops as Parameters<typeof opts.service.syncBatch>[2],
      );
    },
  );

  route.get(
    "/:walletId",
    {
      schema: {
        params: walletIdParam,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(50_000).optional(),
        }),
        response: { 200: listResponse },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const rows = await opts.service.listByWallet(req.params.walletId, u.id, {
        ...(req.query.limit !== undefined ? { limit: req.query.limit } : {}),
      });
      return rows.map((r) => ({
        ...r,
        opTime: r.opTime.toISOString(),
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      }));
    },
  );

  route.get(
    "/:walletId/status",
    {
      schema: {
        params: walletIdParam,
        response: { 200: statusResponse },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const s = await opts.service.syncStatus(req.params.walletId, u.id);
      return {
        walletId: s.walletId,
        latestOpTime: s.latestOpTime ? s.latestOpTime.toISOString() : null,
        opsCount: s.opsCount,
      };
    },
  );

  // UCB A1: server-side cross-wallet internal transfer graph (Layer 1).
  // Scoped к текущему user'у — даже если tx_hash случайно совпал с чужим
  // wallet, service фильтрует через `accounts.owner_id`.
  route.get(
    "/graph/internal-transfers",
    {
      schema: {
        response: { 200: graphInternalTransfersResponse },
      },
      // Six find-*-graph queries fan out per user; cap re-clicks.
      config: { rateLimit: HEAVY_SYNC_LIMIT },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      // L1 (exact tx_hash), L2 (heuristic cross-chain), A5 (cycles) и C2
      // (CEX hops) запускаем параллельно — все запросы независимы.
      const [
        pairs,
        crossChainPairs,
        selfBridgeCycles,
        cexHopChains,
        multiHopCycles,
        untrackedDestinations,
      ] = await Promise.all([
        opts.service.findCrossWalletInternalTransfers(u.id),
        opts.service.findCrossChainInternalTransfers(u.id),
        opts.service.findSelfBridgeCycles(u.id),
        opts.service.findCexHopChains(u.id),
        opts.service.findMultiHopCycles(u.id),
        opts.service.findUntrackedDestinations(u.id),
      ]);
      const stripPair = (p: typeof crossChainPairs[number]) => ({
        outTxHash: p.outTxHash,
        inTxHash: p.inTxHash,
        outChain: p.outChain,
        inChain: p.inChain,
        outWalletId: p.outWalletId,
        inWalletId: p.inWalletId,
        symbol: p.symbol,
        outAmount: p.outAmount,
        inAmount: p.inAmount,
        feeUsd: p.feeUsd,
        outRaw: p.outRaw,
        inRaw: p.inRaw,
      });
      return {
        pairs: pairs.map((p) => ({
          txHash: p.txHash,
          chain: p.chain,
          opTime: p.opTime.toISOString(),
          outWalletId: p.outWalletId,
          outOpType: p.outOpType,
          outRaw: p.outRaw,
          inWalletId: p.inWalletId,
          inOpType: p.inOpType,
          inRaw: p.inRaw,
        })),
        crossChainPairs: crossChainPairs.map(stripPair),
        selfBridgeCycles: selfBridgeCycles.map((c) => ({
          originWalletId: c.originWalletId,
          hopWalletId: c.hopWalletId,
          family: c.family,
          legA: stripPair(c.legA),
          legB: stripPair(c.legB),
          totalFeeUsd: c.totalFeeUsd,
          durationSec: c.durationSec,
        })),
        cexHopChains: cexHopChains.map((h) => ({
          walletId: h.walletId,
          family: h.family,
          fromCex: {
            cexAccountId: h.fromCex.cexAccountId,
            cexExchange: h.fromCex.cexExchange,
          },
          toCex: {
            cexAccountId: h.toCex.cexAccountId,
            cexExchange: h.toCex.cexExchange,
          },
          inboundTxHash: h.inboundTxHash,
          outboundTxHash: h.outboundTxHash,
          inboundChain: h.inboundChain,
          outboundChain: h.outboundChain,
          inboundAmount: h.inboundAmount,
          outboundAmount: h.outboundAmount,
          inboundTimeSec: h.inboundTimeSec,
          outboundTimeSec: h.outboundTimeSec,
          durationSec: h.durationSec,
        })),
        multiHopCycles: multiHopCycles.map((c) => ({
          originWalletId: c.originWalletId,
          walletPath: [...c.walletPath],
          legs: c.legs.map(stripPair),
          totalFeeUsd: c.totalFeeUsd,
          durationSec: c.durationSec,
          families: [...c.families],
        })),
        untrackedDestinations: untrackedDestinations.map((u) => ({
          txHash: u.txHash,
          asset: u.asset,
          amount: u.amount,
          exchange: u.exchange,
          executedAt: u.executedAt.toISOString(),
        })),
      };
    },
  );
}
