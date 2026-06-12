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
import { linkAsyncDeposits } from "@cap-flow/ucb/async_deposit_linker";
import {
  buildOpenPositions,
  type OpenPosition,
} from "@cap-flow/ucb/open_positions";
import { applyLendingCostBasisOverride } from "@cap-flow/ucb/lending_cost_basis_override";
import {
  applyCexInheritanceCostBasisOverride,
} from "@cap-flow/ucb/cex_inheritance_cost_basis_override";
import { applyKrystalV3Override } from "@cap-flow/ucb/krystal/override";
import { applyNonLpOpenerOverride } from "@cap-flow/ucb/apply_opener_override";
import { applyV3CostBasisOverride } from "@cap-flow/ucb/v3_cost_basis_override";
import type {
  V3CostBasisResult,
  V3Position,
} from "@cap-flow/ucb/v3_types";
import type { NonLpOpener } from "@cap-flow/ucb/non_lp_opener";
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
import type { PositionTracker } from "@cap-flow/ucb/positions/position_tracker";

import { PipelineTrace, diffStartUsd } from "./pipeline-trace.js";

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
  /**
   * B4: non-LP opener source — given the built positions, fetches the
   * Etherscan/Alchemy receipt-token openers (+ OUT-side cost basis) and returns
   * the `nonLpOpenerKey`-keyed map `applyNonLpOpenerOverride` consumes. Absent →
   * guarded no-op (non-LP positions keep their UCB/DeBank values). Async I/O is
   * consistent with `opPricingService` (this service is not pure compute).
   */
  nonLpOpenerSource?: NonLpOpenerSourceLike;
  /**
   * B3-full: non-Krystal V3 cost basis source (Etherscan events + slot0 pricing).
   * Runs FIRST (right after build, before lending) — mirrors the client. Absent →
   * guarded no-op. Krystal-covered V3 still gets its authoritative startUsd later.
   */
  v3EnrichmentSource?: V3EnrichmentSourceLike;
  /** FIFO/LIFO/WAC/HIFO — defaults to the client default. */
  lotMethodology?: LotMethodology;
  /**
   * Pipeline observability (pipeline-trace.ts): этапы пишут статус/метрики/
   * warnings сюда. Absent → локальный экземпляр (записи отбрасываются).
   * Инвариант: НЕ влияет на расчёт — positions байт-в-байт одинаковы с/без.
   */
  trace?: PipelineTrace;
}

/** Slice of `NonLpOpenerSource` the engine needs (injectable / stubable). */
export interface NonLpOpenerSourceLike {
  forPositions(
    positions: readonly OpenPosition[],
    walletAddressById: ReadonlyMap<string, string>,
    signal?: AbortSignal,
  ): Promise<Map<string, NonLpOpener>>;
}

/** Slice of `V3EnrichmentSource` the engine needs (injectable / stubable). */
export interface V3EnrichmentSourceLike {
  forPositions(
    positions: readonly OpenPosition[],
    walletAddressById: ReadonlyMap<string, string>,
    signal?: AbortSignal,
  ): Promise<{
    v3PositionMap: Map<string, V3Position[]>;
    v3CostBasis: Map<string, V3CostBasisResult>;
  }>;
  resolveDeploymentIds(chainCode: string, protocolName: string): string[];
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
  const trace = deps.trace ?? new PipelineTrace();

  // ── Step 0: link async-deposit pairs (GMX V2 GLV/GM, Adrena, GMSOL, Flash) ──
  // GMX-style deposits execute in TWO txs: Tx A (user sends USDC/ETH) + Tx B
  // (keeper mints the GM/GLV receipt). The client runs this in
  // LoadedWalletsProvider; the server port previously skipped it, so the receipt
  // lot got DeBank's receipt-spot m.usd instead of the USDC actually paid. When
  // the receipt is then moved cross-protocol (GLV → Morpho collateral), the
  // cost basis came out wrong (artur Morpho $15,535 vs paid $21,586). The linker
  // writes `linkedCostBasisUsd` (= Σ Tx A outgoing) onto Tx B; the shared engine
  // already reads it (position_lot_cost_basis / cross_protocol). Per-wallet, like
  // the client. Pure + immutable (returns new ops arrays).
  const linkedWallets = await trace.run("link", (h) => {
    const out = wallets.map((w) => ({
      ...w,
      ops: linkAsyncDeposits(w.ops),
    }));
    h.metric("wallets", out.length);
    h.metric("ops", out.reduce((s, w) => s + w.ops.length, 0));
    return out;
  });

  // ── Step 1a: histPrices from the B1 op-token-price cache ──
  // ПОРЯДОК (фикс F1, аудит melody789789 2026-06-11): цены загружаются ДО
  // ledger и передаются в runUcbPipelineForWallet. Раньше LotTracker строился
  // БЕЗ histPrices → волатильный transfer_in ценился fallback'ом m.usd =
  // DeBank-спот на момент СИНКА (вся история по сегодняшней цене) → lending
  // startUsd занижен (−27% Aave arb) и «плыл» с рынком между прогонами.
  // Методика locked 2026-06-10: transfer_in волатильного = рынок на момент
  // получения (hist-цена), не спот синка.
  const allOps: ClassifiedOp[] = linkedWallets.flatMap((w) => w.ops);
  const { histPrices } = await trace.run("price", async (h) => {
    const out = await deps.opPricingService.priceMapForOps(allOps);
    h.metric("ops", allOps.length);
    h.metric("priced", out.histPrices.size);
    // «83 missing → 0 filled» класса melody789789: пропуски исторических цен
    // раньше умирали в console.log — теперь это warn-статус этапа.
    if (out.missing.length > 0)
      h.warn(`${out.missing.length} ops без исторической цены (fallback на спот/face)`);
    return out;
  });

  // ── Step 1: per-wallet UCB pipeline → lot tracker (= newTrackers) ──
  const lotsByWallet = new Map<string, LotTracker>();
  // cross_protocol PositionTracker (SoT) per wallet — для tracker_divergence guard.
  const trackersByWallet = new Map<string, PositionTracker>();
  await trace.run("ledger", () => {
    const walletNameById = new Map<string, string>();
    for (const w of linkedWallets) walletNameById.set(w.wallet.id, w.wallet.name);
    for (const w of linkedWallets) {
      const result = runUcbPipelineForWallet({
        walletId: w.wallet.id,
        ops: w.ops,
        annotationsByKey: deps.annotationsByKey ?? new Map(),
        costBasisOverrideByHash,
        histPrices,
        ...(deps.resolvedAnnotations !== undefined && {
          resolvedAnnotations: deps.resolvedAnnotations,
        }),
        walletNameById,
      });
      lotsByWallet.set(w.wallet.id, result.lotTracker);
      if (result.positionTracker)
        trackersByWallet.set(w.wallet.id, result.positionTracker);
    }
  });

  // ── Step 2: buildOpenPositions ──
  // NB: buildOpenPositions' `histPrices` arg is the V3-lp-add-OUT-token map
  // (empty until B3); the main histPrices feeds the lending override below —
  // exactly as the client wires it (use_computed_positions.ts).
  const positionsRaw = await trace.run("build", async (h) => {
    const out = buildOpenPositions(
    linkedWallets.map((w) => ({
      wallet: w.wallet,
      ops: w.ops,
      ...(w.live !== undefined && { live: w.live }),
    })),
    {
      histPrices: new Map<string, number>(),
      costBasisOverrideByHash,
      lotsByWallet,
      // Task #18: thread the FIFO/LIFO/WAC toggle into buildSupplyToken just
      // like the client (use_computed_positions.ts). Without it buildSupplyToken
      // fell back to "WAC" (open_positions.ts `methodology ?? "WAC"`) → lending
      // supply cost basis was methodology-INDEPENDENT server-side, diverging from
      // the client whenever the user picked LIFO/FIFO (artur ETH Fluid +4.4%).
      // The lending override below is C7-skipped once buildSupplyToken yields a
      // cost_basis result, so the methodology MUST reach buildSupplyToken to matter.
      methodology: lotMethodology,
    },
    );
    h.metric("positions", out.length);
    return out;
  });

  const walletAddressById = new Map<string, string>(
    wallets.map((w) => [w.wallet.id, w.wallet.address]),
  );

  // ── Step 2.5: V3 cost basis override (B3-full) — FIRST in the chain ──
  // Mirrors the client (use_computed_positions.ts: applyV3CostBasisOverride runs
  // right after build, before lending). Authoritative non-Krystal V3 LP cost
  // basis from on-chain IncreaseLiquidity events + slot0 pricing (Velodrome gauge
  // etc.). Guarded: no source / empty maps → no-op. Krystal-covered V3 still gets
  // its authoritative startUsd from the Krystal step below.
  let v3Overridden: readonly OpenPosition[] = positionsRaw;
  if (deps.v3EnrichmentSource) {
    v3Overridden = await trace.run("override.v3", async (h) => {
      const { v3PositionMap, v3CostBasis } =
        await deps.v3EnrichmentSource!.forPositions(positionsRaw, walletAddressById);
      if (v3PositionMap.size === 0 || v3CostBasis.size === 0) {
        h.metric("changed", 0);
        return positionsRaw;
      }
      const out = applyV3CostBasisOverride(
        positionsRaw,
        v3PositionMap,
        v3CostBasis,
        (chain, name) => deps.v3EnrichmentSource!.resolveDeploymentIds(chain, name),
      ).positions;
      diffStartUsd(positionsRaw, out, h);
      return out;
    });
  } else trace.skip("override.v3", "нет v3EnrichmentSource");

  // ── Step 3: lending cost basis override (FIFO/LIFO/WAC) ──
  const opsByWallet = new Map<string, ClassifiedOp[]>();
  for (const w of linkedWallets) opsByWallet.set(w.wallet.id, w.ops);
  const lendingResult = await trace.run("override.lending", async (h) => {
    const out = applyLendingCostBasisOverride(
      v3Overridden,
      opsByWallet,
      histPrices,
      lotMethodology,
      costBasisOverrideByHash,
    );
    diffStartUsd(v3Overridden, out.positions, h);
    return out;
  });

  // ── Step 4: CEX inheritance override (B2) ──
  // Positions whose supplied asset arrived from a CEX inherit the exchange-side
  // cost basis. Guarded: empty map → no-op (the override itself early-returns).
  let working = lendingResult.positions;
  if (deps.cexCostBasisByHash && deps.cexCostBasisByHash.size > 0) {
    working = await trace.run("override.cex", async (h) => {
      const before = working;
      const out = applyCexInheritanceCostBasisOverride(
        before,
        opsByWallet,
        deps.cexCostBasisByHash!,
        histPrices,
      ).positions;
      diffStartUsd(before, out, h);
      return out;
    });
  } else trace.skip("override.cex", "нет CEX cost basis matches");

  // ── Step 4.7: Krystal V3 override (B3) ──
  // AUTHORITATIVE startUsd for covered V3 LP (Krystal Σ DEPOSIT) + sets
  // matchedV3TokenId. Guarded: empty map → slice no-op. The V3 cost-basis
  // override (slot0/Etherscan) stays deferred (needs v3PositionMap from B3 step6).
  if (deps.krystalV3ByTokenId && deps.krystalV3ByTokenId.size > 0) {
    working = await trace.run("override.krystal", async (h) => {
      const before = working;
      const out = applyKrystalV3Override(
        before,
        deps.krystalV3ByTokenId!,
        walletAddressById,
        deps.krystalTxByTokenId,
      );
      diffStartUsd(before, out, h);
      return out;
    });
  } else trace.skip("override.krystal", "нет Krystal-данных (источник пуст/недоступен)");

  // ── Step 4.8: non-LP opener override (B4) ──
  // Mirrors the tail of useComputedPositions: for non-V3-LP positions, fetch the
  // Etherscan/Alchemy receipt-token opener (date + OUT-side cost basis) and apply
  // it AFTER Krystal (V3 LP is guarded out inside the override). Guarded: no
  // source / empty map → no-op. Targets are derived from the post-Krystal
  // positions, but chain/lpTokenId/walletId are override-invariant so the target
  // set matches the client's `positionsRaw`-derived targets.
  if (deps.nonLpOpenerSource) {
    working = await trace.run("override.opener", async (h) => {
      const before = working;
      const openerByKey = await deps.nonLpOpenerSource!.forPositions(
        before,
        walletAddressById,
      );
      h.metric("openers", openerByKey.size);
      if (openerByKey.size === 0) {
        h.metric("changed", 0);
        return before;
      }
      const out = applyNonLpOpenerOverride(
        before,
        openerByKey,
        walletAddressById,
      ).positions;
      // Аудит melody789789 F2: именно этот слой подменял верный face-cost на
      // spot (0x7c11) и клеил чужой рынок (0x450b) — дельты теперь видимы.
      diffStartUsd(before, out, h);
      return out;
    });
  } else trace.skip("override.opener", "нет nonLpOpenerSource");

  // ── tracker_divergence guard ──
  // Для lending позиций проставляем cost basis по cross_protocol PositionTracker
  // (SoT) рядом с display `startUsd` (buildSupplyToken / lending-override). Если
  // они разойдутся — детектор поднимет `tracker_divergence` (класс aida POS-001:
  // display падал в market-спот, SoT держал уплаченное). Только lending —
  // lot-traced, без внешнего Krystal/V3-override → без ложных срабатываний на LP.
  const enriched = await trace.run("verify.tracker", async (h) => {
    let divergent = 0;
    const out = working.map((p) => {
    if (p.kind !== "lending") return p;
    const tracker = trackersByWallet.get(p.walletId);
    if (!tracker) return p;
    // 2026-06-10 (testakk Fluid): asset-level SoT = СУММА всех корзин трекера
    // с этим collateral. Receipt-less протоколы раскладывают supplies одного
    // волта по разным market-ключам (волт-ключ + synthetic) — первая корзина
    // недосчитывала ($20k из $31.6k) → ложный tracker_divergence. Чек на своей
    // стороне группирует display-позиции по тому же (wallet, proto, asset).
    for (const t of p.supplyTokens) {
      const entries = tracker.findAllByCollateral(
        p.walletId,
        p.protocol.id,
        t.symbol,
      );
      if (entries.length === 0) continue;
      const sum = entries.reduce((s, e) => s + e.currentCostBasisUsd, 0);
      if (
        p.startUsd != null &&
        sum > 0 &&
        Math.abs(p.startUsd - sum) / Math.max(p.startUsd, sum) > 0.05
      )
        divergent++;
      return { ...p, costBasisTrackerUsd: sum };
    }
    return p;
    });
    h.metric("positions", out.length);
    // Класс aida/melody F1: display startUsd ≠ SoT-трекер. Сам флаг поднимает
    // детектор (tracker_divergence); здесь — только видимость на конвейере.
    if (divergent > 0)
      h.warn(`${divergent} lending-позиций расходятся с SoT-трекером >5%`);
    return out;
  });

  // V3 cost-basis (B3 step6/7) remains a guarded no-op here.
  return enriched;
}
