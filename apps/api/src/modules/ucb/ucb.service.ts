/**
 * B5 (keystone) — server-side UCB orchestrator, COMPUTE-ONLY shadow slice.
 *
 * Runs the SAME canonical `@cap-flow/ucb` engine the client runs in
 * `useComputedPositions`, so the server computes client-identical positions.
 * This is the hook-free `replayPositions` blueprint (apps/web .../replay/
 * replay_positions.ts) lifted to the server: frozen/loaded inputs instead of
 * React hooks, importing ONLY from `@cap-flow/ucb`.
 *
 * Scope of THIS slice (B1-only): the pure portfolio-local chain —
 *   1. runUcbPipelineForWallet (annotations → lot tracker) per wallet
 *      (= LoadedWalletsProvider.newTrackers)
 *   2. buildOpenPositions
 *   3. applyLendingCostBasisOverride (FIFO/LIFO/WAC lot consumption)
 *
 * `histPrices` comes from the B1 `op_token_prices` cache via an injected
 * `OpPriceSource` (the same Map shape the client feeds). The deferred override
 * inputs are guarded no-ops in the client when their data is absent, so a
 * non-V3 / non-CEX / non-opener position computes IDENTICALLY here:
 *   - CEX inheritance      → B2 (cexCostBasisByHash)
 *   - V3 cost basis / Krystal → B3 (v3PositionMap / v3CostBasis / krystal*)
 *   - non-LP opener        → B4 (nonLpOpenerByKey)
 *
 * SHADOW-ONLY: this slice computes and returns positions. It does NOT write a
 * table, expose a route, or flip any flag — those land as separate B5 follow-ups
 * (ucb_shadow_results migration + write path, shadow-diff comparator, the
 * `capflow.feature.ucbServerShadow` flag, refresh-worker wiring).
 */
import { runUcbPipelineForWallet } from "@cap-flow/ucb/ucb_pipeline";
import {
  buildOpenPositions,
  type OpenPosition,
} from "@cap-flow/ucb/open_positions";
import { applyLendingCostBasisOverride } from "@cap-flow/ucb/lending_cost_basis_override";
import {
  applyCexInheritanceCostBasisOverride,
} from "@cap-flow/ucb/cex_inheritance_cost_basis_override";
import { applyKrystalV3Override } from "@cap-flow/ucb/krystal/override";
import type {
  KrystalV3Summary,
  KrystalTransactionsSummary,
} from "@cap-flow/ucb/krystal/adapter";
import type { CexCostBasisMatch } from "@cap-flow/ucb/position_coverage";
import type { ClassifiedOp } from "@cap-flow/ucb/types";
import type { LiveSnapshot } from "@cap-flow/ucb/live";
import type { SavedWallet } from "@cap-flow/ucb/wallet";
import type { ResolvedAnnotation } from "@cap-flow/ucb/annotations";
import type { LotMethodology } from "@cap-flow/ucb/lots/types";
import type { LotTracker } from "@cap-flow/ucb/lots/lot_tracker";

/**
 * Per-wallet engine input. `ops` mirror `chain_operations.raw` with
 * `status === "failed"` already filtered out (R13) by the caller.
 */
export interface UcbComputeWallet {
  wallet: SavedWallet;
  ops: ClassifiedOp[];
  live?: LiveSnapshot;
}

/**
 * The B1 price source. Structurally satisfied by `OpPricingService`; injected so
 * the service stays DB-free and unit-testable with a frozen stub.
 */
export interface OpPriceSource {
  priceMapForOps(
    ops: readonly ClassifiedOp[],
  ): Promise<{ histPrices: Map<string, number>; missing: readonly unknown[] }>;
}

export interface UcbComputeDeps {
  opPricingService: OpPriceSource;
  /** Annotations keyed `${walletId}|${txHash.toLowerCase()}|${logIndex}`. */
  annotationsByKey?: ReadonlyMap<string, ResolvedAnnotation>;
  /** Resolved annotations (manualCostBasisUsd / D8 exclusions / reclassify). */
  resolvedAnnotations?: readonly ResolvedAnnotation[];
  /** Merged cost-basis overrides by tx hash (manual > server CEX). */
  costBasisOverrideByHash?: ReadonlyMap<string, number>;
  /**
   * B2: CEX withdrawal cost basis keyed by lowercased tx hash — lets a position
   * whose supplied asset arrived from a CEX inherit the exchange-side WAC cost
   * basis (mirrors the client's `cexCostBasisByHash`). Empty → guarded no-op.
   */
  cexCostBasisByHash?: ReadonlyMap<string, CexCostBasisMatch>;
  /**
   * B3: Krystal V3 summaries by tokenId (authoritative startUsd for covered LP =
   * Σ DEPOSIT) + per-NFT transactions. Empty → guarded no-op.
   */
  krystalV3ByTokenId?: ReadonlyMap<string, KrystalV3Summary>;
  krystalTxByTokenId?: ReadonlyMap<string, KrystalTransactionsSummary>;
  /** FIFO/LIFO/WAC/HIFO — defaults to the client default. */
  lotMethodology?: LotMethodology;
}

/**
 * Compute the canonical UCB open positions for a set of wallets, server-side,
 * using ONLY `@cap-flow/ucb`. Deterministic: identical inputs → byte-identical
 * output (R4).
 */
export async function computePositions(
  wallets: readonly UcbComputeWallet[],
  deps: UcbComputeDeps,
): Promise<OpenPosition[]> {
  const costBasisOverrideByHash =
    deps.costBasisOverrideByHash ?? new Map<string, number>();
  const lotMethodology: LotMethodology = deps.lotMethodology ?? "FIFO";

  // ── Step 1: per-wallet UCB pipeline → lot tracker (= newTrackers) ──
  const lotsByWallet = new Map<string, LotTracker>();
  const walletNameById = new Map<string, string>();
  for (const w of wallets) walletNameById.set(w.wallet.id, w.wallet.name);
  for (const w of wallets) {
    const result = runUcbPipelineForWallet({
      walletId: w.wallet.id,
      ops: w.ops,
      annotationsByKey: deps.annotationsByKey ?? new Map(),
      costBasisOverrideByHash,
      ...(deps.resolvedAnnotations !== undefined && {
        resolvedAnnotations: deps.resolvedAnnotations,
      }),
      walletNameById,
    });
    lotsByWallet.set(w.wallet.id, result.lotTracker);
  }

  // ── Step 1b: histPrices from the B1 op-token-price cache ──
  const allOps: ClassifiedOp[] = wallets.flatMap((w) => w.ops);
  const { histPrices } = await deps.opPricingService.priceMapForOps(allOps);

  // ── Step 2: buildOpenPositions ──
  // NB: buildOpenPositions' `histPrices` arg is the V3-lp-add-OUT-token map
  // (empty until B3); the main histPrices feeds the lending override below —
  // exactly as the client wires it (use_computed_positions.ts).
  const positionsRaw = buildOpenPositions(
    wallets.map((w) => ({
      wallet: w.wallet,
      ops: w.ops,
      ...(w.live !== undefined && { live: w.live }),
    })),
    {
      histPrices: new Map<string, number>(),
      costBasisOverrideByHash,
      lotsByWallet,
    },
  );

  // ── Step 3: lending cost basis override (FIFO/LIFO/WAC) ──
  const opsByWallet = new Map<string, ClassifiedOp[]>();
  for (const w of wallets) opsByWallet.set(w.wallet.id, w.ops);
  const lendingResult = applyLendingCostBasisOverride(
    positionsRaw,
    opsByWallet,
    histPrices,
    lotMethodology,
    costBasisOverrideByHash,
  );

  // ── Step 4: CEX inheritance override (B2) ──
  // Positions whose supplied asset arrived from a CEX inherit the exchange-side
  // cost basis. Guarded: empty map → no-op (the override itself early-returns).
  let working = lendingResult.positions;
  if (deps.cexCostBasisByHash && deps.cexCostBasisByHash.size > 0) {
    working = applyCexInheritanceCostBasisOverride(
      working,
      opsByWallet,
      deps.cexCostBasisByHash,
      histPrices,
    ).positions;
  }

  // ── Step 4.7: Krystal V3 override (B3) ──
  // AUTHORITATIVE startUsd for covered V3 LP (Krystal Σ DEPOSIT) + sets
  // matchedV3TokenId. Guarded: empty map → slice no-op. The V3 cost-basis
  // override (slot0/Etherscan) stays deferred (needs v3PositionMap from B3 step6).
  if (deps.krystalV3ByTokenId && deps.krystalV3ByTokenId.size > 0) {
    const walletAddressById = new Map<string, string>(
      wallets.map((w) => [w.wallet.id, w.wallet.address]),
    );
    working = applyKrystalV3Override(
      working,
      deps.krystalV3ByTokenId,
      walletAddressById,
      deps.krystalTxByTokenId,
    );
  }

  // V3 cost-basis (B3 step6/7) / non-LP opener (B4) remain guarded no-ops here.
  return working;
}
