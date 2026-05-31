/**
 * Hook-free, offline replay of the canonical UCB open-positions pipeline.
 *
 * Mirrors `useComputedPositions` (the single source of truth) but takes
 * FROZEN inputs instead of React hooks / network fetches, so the engine can
 * run deterministically in tests and (later, A0/B5) server-side. This is the
 * behavioural safety net required BEFORE any engine extraction (see
 * notes/decisions/ucb-server-port-master-plan.md — A0 correction).
 *
 * Scope (A2): the PURE, portfolio-local chain that mirrors
 * `useComputedPositions` —
 *   1. runUcbPipelineForWallet (annotations → lot tracker) per wallet
 *      (= LoadedWalletsProvider.newTrackers)
 *   2. buildOpenPositions
 *   3. applyLendingCostBasisOverride
 *   4. applyCexInheritanceCostBasisOverride (guarded)
 *
 * DEFERRED — pulled in at B3/B4 once server enrichment + a pure V3 path exist:
 *   - applyV3CostBasisOverride / applyV3ClaimedFeesSplit / dedupeMatchedV3TokenIds
 *     (transitively import `@/lib/v3/hook` → React → would break purity here)
 *   - applyKrystalV3Override / filterClosedDustPositions / applyNonLpOpenerOverride
 *     (live in `@/lib/krystal`, `@/lib/nonlp` — hook-adjacent)
 * Every deferred step is guarded by `<data>.size > 0` in the orchestrator, so a
 * non-V3, non-Krystal position replays IDENTICALLY to the client (the deferred
 * steps are no-ops when their inputs are absent).
 */
import { buildOpenPositions, type OpenPosition } from "../open_positions";
import { runUcbPipelineForWallet } from "../ucb_pipeline";
import { applyLendingCostBasisOverride } from "../lending_cost_basis_override";
import { applyCexInheritanceCostBasisOverride } from "../cex_inheritance_cost_basis_override";
import type { ClassifiedOp } from "../types";
import type { LiveSnapshot } from "../live";
import type { SavedWallet } from "../../wallets";
import type { CexCostBasisMatch } from "../position_coverage";
import type { LotMethodology } from "../lots/types";
import type { LotTracker } from "../lots/lot_tracker";
import type { ResolvedAnnotation } from "@/features/chain-ops/api";

export interface ReplayWalletInput {
  wallet: SavedWallet;
  ops: ClassifiedOp[];
  live?: LiveSnapshot;
}

export interface ReplayInput {
  wallets: ReplayWalletInput[];
  /** FIFO/LIFO/WAC/HIFO — defaults to the client default ("FIFO"). */
  lotMethodology?: LotMethodology;
  /** Annotations keyed `${walletId}|${txHash.toLowerCase()}|${logIndex}`. */
  annotationsByKey?: ReadonlyMap<string, ResolvedAnnotation>;
  /** Resolved annotations (manualCostBasisUsd / D8 exclusions / reclassify). */
  resolvedAnnotations?: readonly ResolvedAnnotation[];
  /** Merged cost-basis overrides by tx hash (manual > server CEX). */
  costBasisOverrideByHash?: ReadonlyMap<string, number>;
  /** walletHistPrices — feeds the lending + CEX overrides ("{coin}|{tsHour}" → usd). */
  histPrices?: Map<string, number>;
  /** V3 lp_add OUT-token hist prices — feeds buildOpenPositions. */
  v3LpHistPrices?: Map<string, number>;
  /** Server CEX withdrawal cost basis, keyed by lowercased tx hash. */
  cexCostBasisByHash?: Map<string, CexCostBasisMatch>;
}

export interface ReplayResult {
  /** Post-override positions — the UCB authoritative list. */
  positions: OpenPosition[];
  /** Pre-override positions from buildOpenPositions (diagnostic). */
  positionsRaw: OpenPosition[];
}

/**
 * Run the canonical pipeline over frozen inputs. No hooks, no fetch, no
 * localStorage — fully deterministic and offline.
 */
export function replayPositions(input: ReplayInput): ReplayResult {
  const annotationsByKey =
    input.annotationsByKey ?? new Map<string, ResolvedAnnotation>();
  const costBasisOverrideByHash =
    input.costBasisOverrideByHash ?? new Map<string, number>();
  const histPrices = input.histPrices ?? new Map<string, number>();
  const v3LpHistPrices = input.v3LpHistPrices ?? new Map<string, number>();
  const cexCostBasisByHash =
    input.cexCostBasisByHash ?? new Map<string, CexCostBasisMatch>();
  const lotMethodology: LotMethodology = input.lotMethodology ?? "FIFO";

  // ── Step 1: per-wallet UCB pipeline → lot trackers ──────────────────
  // Mirrors LoadedWalletsProvider.newTrackers (runUcbPipelineForWallet per
  // wallet). Without injected annotations/overrides this is a plain
  // ops → LotTracker build.
  const lotsByWallet = new Map<string, LotTracker>();
  const walletNameById = new Map<string, string>();
  for (const w of input.wallets) walletNameById.set(w.wallet.id, w.wallet.name);
  for (const w of input.wallets) {
    const result = runUcbPipelineForWallet({
      walletId: w.wallet.id,
      ops: w.ops,
      annotationsByKey,
      costBasisOverrideByHash,
      ...(input.resolvedAnnotations !== undefined && {
        resolvedAnnotations: input.resolvedAnnotations,
      }),
      walletNameById,
    });
    lotsByWallet.set(w.wallet.id, result.lotTracker);
  }

  // ── Step 2: buildOpenPositions (raw, pre-override) ──────────────────
  const positionsRaw = buildOpenPositions(
    input.wallets.map((w) => ({
      wallet: w.wallet,
      ops: w.ops,
      ...(w.live !== undefined && { live: w.live }),
    })),
    {
      histPrices: v3LpHistPrices,
      costBasisOverrideByHash,
      lotsByWallet,
    },
  );

  // opsByWallet — shared with the overrides (mirrors useComputedPositions).
  const opsByWallet = new Map<string, ClassifiedOp[]>();
  for (const w of input.wallets) opsByWallet.set(w.wallet.id, w.ops);

  // ── Step 3: lending cost basis override (FIFO/LIFO/WAC) ─────────────
  let working: OpenPosition[] = positionsRaw.slice();
  const lendingResult = applyLendingCostBasisOverride(
    working,
    opsByWallet,
    histPrices,
    lotMethodology,
    costBasisOverrideByHash,
  );
  working = lendingResult.positions;

  // ── Step 4: CEX inheritance override (guarded, like the client) ─────
  if (cexCostBasisByHash.size > 0) {
    const cexResult = applyCexInheritanceCostBasisOverride(
      working,
      opsByWallet,
      cexCostBasisByHash,
      histPrices,
    );
    working = cexResult.positions;
  }

  return { positions: working, positionsRaw };
}
