/**
 * UCB B5.3: client integration with server-side on-chain ops cache.
 *
 * Этот модуль — тонкий transport layer:
 *   - `syncBatch`: push classified ops в БД после успешного DeBank/Helius pull
 *   - `list`: hydrate ops из БД (Phase 2 — для server-side primary cache)
 *   - `status`: latest_op_time + count для UI badge "synced to cloud"
 */
import { z } from "zod";

import { api } from "@/lib/api/client";

export const chainOpResponseSchema = z.object({
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
export type ChainOpResponse = z.infer<typeof chainOpResponseSchema>;

export const chainOpStatusSchema = z.object({
  walletId: z.string().uuid(),
  latestOpTime: z.string().datetime().nullable(),
  opsCount: z.number().int().nonnegative(),
});
export type ChainOpStatus = z.infer<typeof chainOpStatusSchema>;

const syncBatchResponseSchema = z.object({
  inserted: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

const listResponseSchema = z.array(chainOpResponseSchema);

export const graphInternalTransferItemSchema = z.object({
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
export type GraphInternalTransferItem = z.infer<
  typeof graphInternalTransferItemSchema
>;

export const graphCrossChainPairSchema = z.object({
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
export type GraphCrossChainPair = z.infer<typeof graphCrossChainPairSchema>;

// UCB A5: self-bridge cycle (A→B→A loop).
export const graphSelfBridgeCycleSchema = z.object({
  originWalletId: z.string().uuid(),
  hopWalletId: z.string().uuid(),
  family: z.string(),
  legA: graphCrossChainPairSchema,
  legB: graphCrossChainPairSchema,
  totalFeeUsd: z.number(),
  durationSec: z.number(),
});
export type GraphSelfBridgeCycle = z.infer<typeof graphSelfBridgeCycleSchema>;

// UCB C2: CEX A → wallet → CEX B hop chain.
export const graphCexHopChainSchema = z.object({
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
export type GraphCexHopChain = z.infer<typeof graphCexHopChainSchema>;

// UCB A5.2: multi-hop cycle (N legs).
export const graphMultiHopCycleSchema = z.object({
  originWalletId: z.string().uuid(),
  walletPath: z.array(z.string().uuid()),
  legs: z.array(graphCrossChainPairSchema),
  totalFeeUsd: z.number(),
  durationSec: z.number(),
  families: z.array(z.string()),
});
export type GraphMultiHopCycle = z.infer<typeof graphMultiHopCycleSchema>;

// Bob-test fix #4: untracked CEX withdrawal destination.
export const graphUntrackedDestinationSchema = z.object({
  txHash: z.string(),
  asset: z.string(),
  amount: z.number(),
  exchange: z.string(),
  executedAt: z.string().datetime(),
});
export type GraphUntrackedDestination = z.infer<
  typeof graphUntrackedDestinationSchema
>;

const graphInternalTransfersResponseSchema = z.object({
  pairs: z.array(graphInternalTransferItemSchema),
  crossChainPairs: z.array(graphCrossChainPairSchema),
  // UCB A5: optional с default — старые серверы не возвращают.
  selfBridgeCycles: z.array(graphSelfBridgeCycleSchema).optional().default([]),
  // UCB C2: CEX A → wallet → CEX B хопы. Backward compat default [].
  cexHopChains: z.array(graphCexHopChainSchema).optional().default([]),
  // UCB A5.2: N-leg multi-hop cycles. Backward compat default [].
  multiHopCycles: z.array(graphMultiHopCycleSchema).optional().default([]),
  // Bob-test fix #4: untracked withdrawal destinations.
  untrackedDestinations: z
    .array(graphUntrackedDestinationSchema)
    .optional()
    .default([]),
});

// UCB A3: annotations. UCB D8 добавил `excluded`.
export const annotationResponseSchema = z.object({
  id: z.string().uuid(),
  chainOpId: z.string().uuid(),
  userId: z.string().uuid(),
  isInternalTransfer: z.boolean().nullable(),
  manualCostBasisUsd: z.number().nullable(),
  manualOpType: z.string().nullable(),
  note: z.string().nullable(),
  // UCB D8: optional с default false для backward compat (старые серверы).
  excluded: z.boolean().optional().default(false),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AnnotationResponse = z.infer<typeof annotationResponseSchema>;

/**
 * Resolved annotation: server JOIN'ит chain_operations и денормализует
 * (txHash, walletId, logIndex). Client использует эти поля для merge'а
 * с ClassifiedOp[] в памяти без extra round-trip.
 */
export const resolvedAnnotationSchema = annotationResponseSchema.extend({
  txHash: z.string(),
  walletId: z.string().uuid(),
  logIndex: z.number().int(),
});
export type ResolvedAnnotation = z.infer<typeof resolvedAnnotationSchema>;

export const annotationsListResponseSchema = z.object({
  annotations: z.array(resolvedAnnotationSchema),
});

export interface AnnotationUpsertBody {
  readonly isInternalTransfer: boolean | null;
  readonly manualCostBasisUsd: number | null;
  readonly manualOpType: string | null;
  readonly note: string | null;
  /** UCB D8: optional soft-delete flag (server defaults to false). */
  readonly excluded?: boolean;
}

export interface ChainOpInput {
  readonly chain: string;
  readonly txHash: string;
  readonly logIndex?: number;
  readonly opType: string;
  /** Unix seconds — same as ClassifiedOp.time. */
  readonly opTime: number;
  readonly status: string;
  readonly raw: unknown;
}

export const chainOpsApi = {
  syncBatch: (walletId: string, ops: readonly ChainOpInput[]) =>
    api.post(
      `/v1/chain-ops/${walletId}/sync`,
      { ops },
      syncBatchResponseSchema,
    ),

  list: (walletId: string, limit?: number) =>
    api.get(
      `/v1/chain-ops/${walletId}${limit ? `?limit=${limit}` : ""}`,
      listResponseSchema,
    ),

  status: (walletId: string) =>
    api.get(`/v1/chain-ops/${walletId}/status`, chainOpStatusSchema),

  /**
   * UCB A1: server-side cross-wallet internal transfer graph (Layer 1).
   * Returns same-chain self-transfer pairs detected via tx_hash equality.
   * Client merges these со своим heuristic detector'ом для cross-chain.
   */
  graphInternalTransfers: () =>
    api.get(
      `/v1/chain-ops/graph/internal-transfers`,
      graphInternalTransfersResponseSchema,
    ),

  /**
   * UCB A3: per-op user annotations (overrides).
   *   - listAll: bulk-load all user's annotations to apply in-memory
   *   - upsert: PUT — create/update for one (op, user)
   *   - delete: DELETE — remove annotation entirely
   */
  annotations: {
    listAll: () =>
      api.get(
        `/v1/chain-ops/annotations/`,
        annotationsListResponseSchema,
      ),
    upsert: (opId: string, body: AnnotationUpsertBody) =>
      api.put(
        `/v1/chain-ops/annotations/${opId}`,
        body,
        annotationResponseSchema,
      ),
    upsertByKey: (
      body: AnnotationUpsertBody & {
        walletId: string;
        txHash: string;
        logIndex: number;
      },
    ) =>
      api.put(
        `/v1/chain-ops/annotations/by-key`,
        body,
        annotationResponseSchema,
      ),
    delete: (opId: string) =>
      api.delete(`/v1/chain-ops/annotations/${opId}`),
  },
};
