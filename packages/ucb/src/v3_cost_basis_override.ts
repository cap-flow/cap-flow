/**
 * Post-process for V3 LP positions: override startUsd via the authoritative
 * cumulative cost basis from on-chain IncreaseLiquidity events (UCB engine —
 * B3-full layer 1, moved verbatim from web `portfolio/v3_cost_basis_override.ts`).
 *
 * Solves audit problem #2: DeBank returns only the first NFT mint, not the
 * `increaseLiquidity` calls. POS-001 XAUt: live $162 vs DeBank-deposit $57 (3×).
 *
 * Algorithm:
 *   1. For each V3-LP OpenPosition, find its NFTs (live tokenId via v3PositionMap)
 *   2. Sum the cumulative cost basis from v3CostBasis (by nftTokenId)
 *   3. If the authoritative total differs from the DeBank-visible mint sum by more
 *      than DISTANCE_TOLERANCE → override startUsd to the authoritative value
 *   4. Pro-rata distribute if a group has several NFTs
 *
 * Returns a new OpenPosition array (does not mutate the input).
 *
 * Decoupled from `@/lib/v3/chains` (viem deployment config): the deployment-id
 * resolution is INJECTED (`resolveDeploymentIds`) so the package stays viem-free.
 * The web shim passes `findV3Deployments(...).map(d => d.id)`; the server passes
 * its own deployment list.
 */

import type { OpenPosition } from "./open_positions.js";
import { isStableSymbol } from "./protocols.js";
import {
  v3PositionKey,
  type V3CostBasisResult,
  type V3Position,
  type V3PositionMap,
} from "./v3_types.js";

/**
 * Single V3-override tolerance. 1% — tuned (POS-002 Alex 2026-05-08: $475 missing
 * on $14,560 = 3.26% slipped past a 5% threshold → cost basis drifted). Kept tight
 * because the authoritative Alchemy source is usually cent-accurate.
 */
const DISTANCE_TOLERANCE = 0.01;

/** `(chain, protocolName) → matching deployment ids` (injected, viem-free). */
export type ResolveDeploymentIds = (
  chain: string,
  protocolName: string,
) => string[];

/**
 * Local normalize: WETH→ETH, WBTC/TBTC/CBBTC→BTC (canonical wrapped). Used for
 * cross-position price lookup so ETH from one position matches WETH from another.
 */
function normalizeSymbol(s: string): string {
  const u = s.toUpperCase();
  if (u === "WETH") return "ETH";
  if (u === "WBTC" || u === "TBTC" || u === "CBBTC") return "BTC";
  return u;
}

/**
 * When this override replaces a position's `startUsd`, `netStartUsd` must move
 * with it: `netStartUsd = startUsd − borrowProceeds`. We preserve the borrow
 * delta captured in the base position, so a leveraged V3-like position keeps its
 * net offset while a plain LP (no borrow → base net == base start) lands on
 * `netStartUsd === newStartUsd`. Without this the field stays stuck at the
 * pre-override placeholder (= currentUsd for gauge-staked CL that had no traced
 * ops), skewing every net-based APR/ROI (mmaksimuk POS-027 Velodrome gauge).
 * Mirrors the Krystal override, which already updates netStartUsd.
 */
function overriddenNetStartUsd(base: OpenPosition, newStartUsd: number): number {
  const borrowDelta = base.startUsd > 0 ? base.startUsd - base.netStartUsd : 0;
  return Math.max(0, newStartUsd - borrowDelta);
}

/**
 * Orphan-NFT recovery: for any OpenPosition the V3 cost-basis fetch resolved (via
 * on-chain logs) with cb.mintBlockTime + tokenId, clear coverageIncomplete and
 * backfill openedAt/openHash/ageDays/openedInTokens. Used in both override branches.
 */
function backfillOrphanMeta(
  base: OpenPosition,
  cb: V3CostBasisResult,
  nft: V3Position,
): OpenPosition {
  // VolnyySanya audit POS-002: also fix the Phase 1/1.5 match path — if the user
  // had an OLD NFT in the same pool (burnt), DeBank's earliest lp_add op got
  // picked as openedAt → date months before the real mint. Etherscan mintBlockTime
  // is the single source of truth. Backfill ALWAYS runs when cb.mintBlockTime is
  // known and differs from base.openedAt (or it was null).
  if (cb.mintBlockTime === undefined) return base;
  if (
    base.openedAt != null &&
    Math.abs(base.openedAt - cb.mintBlockTime) <= 60
  ) {
    return base;
  }
  const now = Math.floor(Date.now() / 1000);
  const ageDays = Math.max(0, Math.floor((now - cb.mintBlockTime) / 86_400));
  // After orphan backfill ageDays is known → recompute fee APR (buildOne sets
  // feeApr=null for coverageIncomplete=true).
  const feeApr =
    ageDays > 0 && base.startUsd > 0 && base.feesUsd != null
      ? (base.feesUsd / base.startUsd) * (365 / ageDays) * 100
      : null;
  const feeAprLifetime =
    ageDays > 0 && base.startUsd > 0 && base.feesLifetimeUsd > 0
      ? (base.feesLifetimeUsd / base.startUsd) * (365 / ageDays) * 100
      : null;
  return {
    ...base,
    coverageIncomplete: false,
    openedAt: cb.mintBlockTime,
    ...(cb.mintTxHash ? { openHash: cb.mintTxHash } : {}),
    ageDays,
    feeApr,
    feeAprLifetime,
    // Keep existing openedInTokens when cb has no deposit amounts (one-sided
    // deposit — existing ops data may be richer); else overwrite cb-derived.
    openedInTokens:
      cb.totalDeposited0 > 0 || cb.totalDeposited1 > 0
        ? [
            { symbol: nft.token0.symbol, amount: cb.totalDeposited0 },
            { symbol: nft.token1.symbol, amount: cb.totalDeposited1 },
          ]
        : base.openedInTokens,
  };
}

/**
 * Price resolution with fallbacks (first positive wins):
 *   1. priceBySymbol (this position's supplyTokens DeBank live prices)
 *   2. Stable ($1)
 *   3. currentPrices (cross-position lookup from the rest of the portfolio)
 *   4. 0 (last resort → null USD, but amount is still right)
 */
function resolvePrice(
  symbol: string,
  priceBySymbol: ReadonlyMap<string, number>,
  currentPrices?: ReadonlyMap<string, number>,
): number {
  const upper = symbol.toUpperCase();
  const fromSupply = priceBySymbol.get(upper);
  if (fromSupply && fromSupply > 0) return fromSupply;
  if (isStableSymbol(symbol)) return 1;
  if (currentPrices) {
    const fromCross = currentPrices.get(normalizeSymbol(symbol));
    if (fromCross && fromCross > 0) return fromCross;
    const fromUpper = currentPrices.get(upper);
    if (fromUpper && fromUpper > 0) return fromUpper;
  }
  return 0;
}

/**
 * UCB Phase J: on-chain truth for current V3 NFT state. DeBank `lp.supply.amount`
 * can SWAP amounts between portfolio_items of one pool (2+ NFT same pool). When
 * matchedV3TokenId is set → override currentUsd + supplyTokens.amount from the NFT.
 * Prices come from supplyTokens (DeBank live); fallback to cross-position lookup.
 */
function overrideCurrentFromOnChain(
  base: OpenPosition,
  nft: V3Position,
  currentPrices?: ReadonlyMap<string, number>,
  cb?: V3CostBasisResult,
): OpenPosition {
  const priceBySymbol = new Map<string, number>();
  for (const t of base.supplyTokens) {
    if (t.amount > 0 && t.currentUsd > 0) {
      priceBySymbol.set(t.symbol.toUpperCase(), t.currentUsd / t.amount);
    }
  }
  const onChain = [
    { symbol: nft.token0.symbol, amount: nft.amount0Current },
    { symbol: nft.token1.symbol, amount: nft.amount1Current },
  ];
  const newSupplyPreStart = base.supplyTokens.map((t) => {
    const oc = onChain.find(
      (x) => x.symbol.toUpperCase() === t.symbol.toUpperCase(),
    );
    if (!oc) return t;
    const px = resolvePrice(t.symbol, priceBySymbol, currentPrices);
    return { ...t, amount: oc.amount, currentUsd: oc.amount * px };
  });
  const newCurrentUsd = newSupplyPreStart.reduce((s, t) => s + t.currentUsd, 0);

  // Redistribute supplyTokens[].startUsd pro-rata by the new currentUsd split so
  // Σ supplyTokens.startUsd stays consistent with position.startUsd.
  const newSupply = (() => {
    if (newCurrentUsd <= 0 || base.startUsd <= 0) return newSupplyPreStart;
    return newSupplyPreStart.map((t) => ({
      ...t,
      startUsd: (t.currentUsd / newCurrentUsd) * base.startUsd,
    }));
  })();

  // Pending fees — override with on-chain pendingFee0/1 (DeBank lp.rewards is
  // often stale). Gauge-staked Velodrome/Aerodrome: "income" is VELO emissions
  // (DeBank lp.rewards), not V3 trading fees — a staked NFT has tokensOwed=0, so
  // keep the DeBank value rather than zeroing real emissions.
  let newFeesUsd: number | null = base.feesUsd;
  let newFeesByToken: OpenPosition["feesByToken"] = base.feesByToken;
  const isGaugeBased = /velodrome|aerodrome/i.test(nft.protocolLabel);
  if (base.feesSource === "v3_rewards" && !isGaugeBased) {
    const feeAmounts = [
      { symbol: nft.token0.symbol, amount: nft.pendingFee0 },
      { symbol: nft.token1.symbol, amount: nft.pendingFee1 },
    ];
    const newFees = feeAmounts
      .filter((f) => f.amount > 0)
      .map((f) => {
        const px = resolvePrice(f.symbol, priceBySymbol, currentPrices);
        return { symbol: f.symbol, amount: f.amount, usd: f.amount * px, nativeApr: null };
      });
    newFeesUsd = newFees.reduce((s, f) => s + f.usd, 0);
    newFeesByToken = newFees;
  }

  const newPnlUsd = newCurrentUsd - base.startUsd;
  const newPnlPct = base.startUsd > 0 ? (newPnlUsd / base.startUsd) * 100 : 0;

  // Recompute feesLifetimeUsd = pending + claimed, and the APRs.
  const newFeesLifetimeUsd = (newFeesUsd ?? 0) + base.feesClaimedUsd;
  const ageDays = base.ageDays;
  const newFeeAprLifetime =
    ageDays && ageDays > 0 && base.startUsd > 0 && newFeesLifetimeUsd > 0
      ? (newFeesLifetimeUsd / base.startUsd) * (365 / ageDays) * 100
      : base.feeAprLifetime;
  const newFeeApr =
    ageDays && ageDays > 0 && base.startUsd > 0 && newFeesUsd != null
      ? (newFeesUsd / base.startUsd) * (365 / ageDays) * 100
      : base.feeApr;

  // Recompute the v3 popup block (currentLpUsd/IL/pnl). If base.v3 is null but cb
  // is available (orphan NFT without a matched lp_add op) → synthesize v3 from
  // cb.totalDeposited0/1 + cb.netCostBasisUsd.
  const synthesizedV3: OpenPosition["v3"] | null =
    base.v3 == null && cb != null
      ? (() => {
          const depositTokens = [
            { symbol: nft.token0.symbol, amount: cb.totalDeposited0, usdAtDeposit: 0 },
            { symbol: nft.token1.symbol, amount: cb.totalDeposited1, usdAtDeposit: 0 },
          ];
          let hodlUsd = 0;
          for (const t of depositTokens) {
            const px = resolvePrice(t.symbol, priceBySymbol, currentPrices);
            if (px > 0) hodlUsd += t.amount * px;
          }
          return {
            depositTokens,
            depositUsd: cb.netCostBasisUsd,
            hodlUsd,
            currentLpUsd: 0,
            impermanentLossUsd: 0,
            pnlUsd: 0,
            pnlPct: 0,
            pricesSource: "historical" as const,
          };
        })()
      : null;
  const v3Source = base.v3 ?? synthesizedV3;
  const newV3 = v3Source
    ? (() => {
        const newCurrentLpUsd = newCurrentUsd;
        const newImpermanentLossUsd = v3Source.hodlUsd - newCurrentLpUsd;
        const newV3PnlUsd = newCurrentLpUsd - v3Source.depositUsd;
        const newV3PnlPct =
          v3Source.depositUsd > 0 ? (newV3PnlUsd / v3Source.depositUsd) * 100 : 0;
        return {
          ...v3Source,
          currentLpUsd: newCurrentLpUsd,
          impermanentLossUsd: newImpermanentLossUsd,
          pnlUsd: newV3PnlUsd,
          pnlPct: newV3PnlPct,
        };
      })()
    : base.v3;

  return {
    ...base,
    supplyTokens: newSupply,
    currentUsd: newCurrentUsd,
    netPnlUsd: newPnlUsd,
    netPnlPct: newPnlPct,
    feesUsd: newFeesUsd,
    feesByToken: newFeesByToken,
    feesLifetimeUsd: newFeesLifetimeUsd,
    feeAprLifetime: newFeeAprLifetime,
    feeApr: newFeeApr,
    ...(newV3 && { v3: newV3 }),
  };
}

export interface OverrideResult {
  positions: OpenPosition[];
  /** Diagnostic: how many positions were overridden. */
  overriddenCount: number;
  /** Diagnostic: groups with a warning. */
  warnings: string[];
}

export function applyV3CostBasisOverride(
  positions: readonly OpenPosition[],
  v3PositionMap: V3PositionMap,
  v3CostBasis: Map<string, V3CostBasisResult>,
  resolveDeploymentIds: ResolveDeploymentIds,
): OverrideResult {
  const result: OpenPosition[] = positions.map((p) => p);
  const warnings: string[] = [];
  let overriddenCount = 0;

  // Cross-position price lookup. symbol → price (USD/unit) from supplyTokens /
  // debtTokens where DeBank returned valid values. First valid price per symbol.
  const currentPrices = new Map<string, number>();
  const noteIfFresh = (symbol: string, amount: number, usd: number): void => {
    if (amount <= 0 || usd <= 0) return;
    const px = usd / amount;
    if (px <= 0 || !Number.isFinite(px)) return;
    const upper = symbol.toUpperCase();
    if (!currentPrices.has(upper)) currentPrices.set(upper, px);
    const norm = normalizeSymbol(symbol);
    if (!currentPrices.has(norm)) currentPrices.set(norm, px);
  };
  for (const p of positions) {
    for (const t of p.supplyTokens) noteIfFresh(t.symbol, t.amount, t.currentUsd);
    // NOTE: the web original also looped debtTokens with `t.currentUsd`, but
    // debtTokens has no `currentUsd` field (only `usd`) → it read `undefined` →
    // NaN → noteIfFresh always skipped it (a latent no-op, one of web's baseline
    // tsc errors). Omitted here to keep the output byte-identical AND type-clean.
  }

  if (v3PositionMap.size === 0 || v3CostBasis.size === 0) {
    return { positions: result, overriddenCount: 0, warnings: [] };
  }

  // Group positions by v3PositionKey (= walletId|chain|deploymentId|sortedSymbols).
  type GroupItem = { p: OpenPosition; idx: number };
  const groups = new Map<string, GroupItem[]>();

  for (let idx = 0; idx < result.length; idx++) {
    const p = result[idx]!;
    // Use protocol.name → resolveDeploymentIds to detect V3 (not p.v3) — upstream
    // buildV3Details may return null for secondary positions due to
    // consumedMintHashes dedup, but the override still needs to process them.
    const depIds = resolveDeploymentIds(p.chain, p.protocol.name);
    if (depIds.length === 0) continue;
    for (const depId of depIds) {
      const key = v3PositionKey({
        walletId: p.walletId,
        chain: p.chain,
        deploymentId: depId,
        symbols: p.supplyTokens.map((t) => t.symbol),
      });
      if (!v3PositionMap.has(key)) continue;
      const arr = groups.get(key) ?? [];
      arr.push({ p, idx });
      groups.set(key, arr);
      break;
    }
  }

  // mintTxHash → V3CostBasisResult for per-NFT precision (mint tx === openHash).
  const byMintHash = new Map<string, V3CostBasisResult>();
  for (const cb of v3CostBasis.values()) {
    if (cb.mintTxHash) byMintHash.set(cb.mintTxHash.toLowerCase(), cb);
  }

  for (const [key, items] of groups) {
    const nfts = v3PositionMap.get(key) ?? [];
    if (nfts.length === 0) continue;

    // R4: один NFT не должен назначаться двум позициям. PHASE 1.5 ранее исключал
    // NFT только по openHash/mintTxHash — если они не совпадали (DeBank
    // ambiguity), уже назначенный в PHASE 1 NFT переиспользовался → дубликат
    // позиции (Alice PAXG: #1159873 терялся, #1219136 дублировался). Трекаем
    // фактически назначенные tokenId и исключаем их во всех фазах.
    const assignedTokenIds = new Set<string>();

    // PHASE 0: детерминированный match по NFT-id из источника (DeBank
    // `description` = "#1219136"). В одном пуле несколько NFT одной пары
    // различаются ТОЛЬКО по tokenId — lpTokenId=pool общий, а amount-proximity
    // (PHASE 1.5) нестабилен между fetch'ами (Alice PAXG #1159873/#1219136:
    // дубликат + пропажа позиции). Если позиция знает свой nftId и среди
    // on-chain NFT есть такой tokenId — пиннингуем напрямую (+ Phase-J on-chain
    // amounts из правильной NFT). Самый надёжный ключ, без эвристик.
    const phase0Done = new Set<number>();
    for (let i = 0; i < items.length; i++) {
      const x = items[i]!;
      const nftId = x.p.nftId;
      if (!nftId || assignedTokenIds.has(nftId)) continue;
      const nft = nfts.find((n) => n.tokenId.toString() === nftId);
      if (!nft) continue;
      const cb = v3CostBasis.get(nftId);
      assignedTokenIds.add(nftId);
      phase0Done.add(i);
      const oldStartUsd = x.p.startUsd;
      let next: OpenPosition = { ...x.p, matchedV3TokenId: nftId };
      if (cb && cb.netCostBasisUsd > 0) {
        const newStartUsd = cb.netCostBasisUsd;
        const withinTol =
          oldStartUsd > 0 &&
          Math.abs(newStartUsd - oldStartUsd) / oldStartUsd < DISTANCE_TOLERANCE;
        if (!withinTol) {
          next.startUsd = newStartUsd;
          next.netStartUsd = overriddenNetStartUsd(x.p, newStartUsd);
          if (oldStartUsd > 0) {
            next.supplyTokens = x.p.supplyTokens.map((t) => ({
              ...t,
              startUsd: (t.startUsd / oldStartUsd) * newStartUsd,
            }));
          }
          overriddenCount++;
        }
        next = backfillOrphanMeta(next, cb, nft);
      }
      // Phase-J on-chain amounts из ИМЕННО этой NFT (фикс DeBank amount-swap).
      next = overrideCurrentFromOnChain(next, nft, currentPrices, cb);
      next.netPnlUsd = next.currentUsd - next.startUsd;
      next.netPnlPct = next.startUsd > 0 ? (next.netPnlUsd / next.startUsd) * 100 : 0;
      result[x.idx] = next;
      warnings.push(
        `[V3 override nft-id] ${x.p.id} (NFT #${nftId}) deterministic via source description`,
      );
    }
    // PHASE 1+ обрабатывают только не-PHASE-0 позиции.
    const pending =
      phase0Done.size > 0 ? items.filter((_, i) => !phase0Done.has(i)) : items;

    // PHASE 1: per-NFT precision via openHash → mintTxHash match. Skip ambiguous
    // openHash (DeBank sometimes returns the same mint tx for two NFTs) → Phase 1.5.
    const openHashCount = new Map<string, number>();
    for (const x of pending) {
      const oh = (x.p.openHash ?? "").toLowerCase();
      if (!oh) continue;
      openHashCount.set(oh, (openHashCount.get(oh) ?? 0) + 1);
    }
    const itemsWithoutMatch: typeof items = [];
    const matchedTotalAuth: number[] = [];
    for (const x of pending) {
      const oh = (x.p.openHash ?? "").toLowerCase();
      const isAmbiguous = oh && (openHashCount.get(oh) ?? 0) > 1;
      const cb = oh && !isAmbiguous ? byMintHash.get(oh) : undefined;
      if (cb && cb.netCostBasisUsd > 0) {
        const oldStartUsd = x.p.startUsd;
        const newStartUsd = cb.netCostBasisUsd;
        const nftForCb = nfts.find(
          (n) => n.tokenId.toString() === cb.tokenId.toString(),
        );
        assignedTokenIds.add(cb.tokenId.toString());
        if (oldStartUsd > 0 && Math.abs(newStartUsd - oldStartUsd) / oldStartUsd < DISTANCE_TOLERANCE) {
          let next: OpenPosition = { ...x.p, matchedV3TokenId: cb.tokenId.toString() };
          if (nftForCb) {
            next = backfillOrphanMeta(next, cb, nftForCb);
            next = overrideCurrentFromOnChain(next, nftForCb, currentPrices, cb);
          }
          result[x.idx] = next;
          matchedTotalAuth.push(newStartUsd);
          continue;
        }
        let next: OpenPosition = { ...x.p };
        next.startUsd = newStartUsd;
        next.netStartUsd = overriddenNetStartUsd(x.p, newStartUsd);
        next.matchedV3TokenId = cb.tokenId.toString();
        if (oldStartUsd > 0) {
          next.supplyTokens = x.p.supplyTokens.map((t) => ({
            ...t,
            startUsd: (t.startUsd / oldStartUsd) * newStartUsd,
          }));
        }
        if (nftForCb) {
          next = backfillOrphanMeta(next, cb, nftForCb);
          next = overrideCurrentFromOnChain(next, nftForCb, currentPrices, cb);
        }
        // H6: collateral-side PnL only (do NOT subtract currentDebtUsd).
        next.netPnlUsd = next.currentUsd - next.startUsd;
        next.netPnlPct = next.startUsd > 0 ? (next.netPnlUsd / next.startUsd) * 100 : 0;
        result[x.idx] = next;
        overriddenCount++;
        matchedTotalAuth.push(newStartUsd);
        warnings.push(
          `[V3 override per-NFT] ${x.p.id} (NFT #${cb.tokenId}): ` +
            `$${oldStartUsd.toFixed(2)} → $${newStartUsd.toFixed(2)} (mint tx ${oh.slice(0, 10)}…)`,
        );
      } else {
        itemsWithoutMatch.push(x);
      }
    }

    if (itemsWithoutMatch.length === 0) continue;

    // PHASE 1.5: greedy match by current token amounts (openHash unreliable).
    const matchedHashesPhase1 = new Set(
      items
        .filter((x) => !itemsWithoutMatch.includes(x))
        .map((x) => (x.p.openHash ?? "").toLowerCase()),
    );
    const availableNfts = nfts.filter((nft) => {
      if (assignedTokenIds.has(nft.tokenId.toString())) return false;
      const cb = v3CostBasis.get(nft.tokenId.toString());
      if (!cb) return true;
      if (cb.mintTxHash && matchedHashesPhase1.has(cb.mintTxHash.toLowerCase())) {
        return false;
      }
      return true;
    });
    if (availableNfts.length > 0 && itemsWithoutMatch.length > 0) {
      type Pair = { itemIdx: number; nftIdx: number; dist: number };
      const pairs: Pair[] = [];
      for (let i = 0; i < itemsWithoutMatch.length; i++) {
        const x = itemsWithoutMatch[i]!;
        const supplyBySym = new Map<string, number>();
        for (const t of x.p.supplyTokens) {
          supplyBySym.set(t.symbol.toUpperCase(), t.amount);
        }
        for (let j = 0; j < availableNfts.length; j++) {
          const nft = availableNfts[j]!;
          const sym0 = nft.token0.symbol.toUpperCase();
          const sym1 = nft.token1.symbol.toUpperCase();
          const a0 = supplyBySym.get(sym0) ?? 0;
          const a1 = supplyBySym.get(sym1) ?? 0;
          const n0 = nft.amount0Current;
          const n1 = nft.amount1Current;
          const d0 = (a0 + n0) > 0 ? Math.abs(a0 - n0) / Math.max(a0, n0, 1e-9) : 0;
          const d1 = (a1 + n1) > 0 ? Math.abs(a1 - n1) / Math.max(a1, n1, 1e-9) : 0;
          pairs.push({ itemIdx: i, nftIdx: j, dist: d0 + d1 });
        }
      }
      // Стабильный порядок (R4): при равном dist tie-break по индексам, иначе
      // greedy назначал по-разному между прогонами (недетерминизм матчинга).
      pairs.sort((a, b) => a.dist - b.dist || a.itemIdx - b.itemIdx || a.nftIdx - b.nftIdx);
      const itemConsumed = new Set<number>();
      const nftConsumed = new Set<number>();
      const greedyMatched: { item: (typeof items)[number]; nft: (typeof nfts)[number] }[] = [];
      for (const p of pairs) {
        if (itemConsumed.has(p.itemIdx) || nftConsumed.has(p.nftIdx)) continue;
        if (p.dist > 1.0) break;
        itemConsumed.add(p.itemIdx);
        nftConsumed.add(p.nftIdx);
        greedyMatched.push({
          item: itemsWithoutMatch[p.itemIdx]!,
          nft: availableNfts[p.nftIdx]!,
        });
      }
      const stillUnmatched: typeof items = [];
      for (let i = 0; i < itemsWithoutMatch.length; i++) {
        if (!itemConsumed.has(i)) stillUnmatched.push(itemsWithoutMatch[i]!);
      }
      for (const { item, nft } of greedyMatched) {
        const cb = v3CostBasis.get(nft.tokenId.toString());
        if (!cb || cb.netCostBasisUsd <= 0) {
          stillUnmatched.push(item);
          continue;
        }
        assignedTokenIds.add(nft.tokenId.toString());
        const oldStartUsd = item.p.startUsd;
        const newStartUsd = cb.netCostBasisUsd;
        if (oldStartUsd > 0 && Math.abs(newStartUsd - oldStartUsd) / oldStartUsd < DISTANCE_TOLERANCE) {
          let next: OpenPosition = { ...item.p, matchedV3TokenId: nft.tokenId.toString() };
          next = backfillOrphanMeta(next, cb, nft);
          next = overrideCurrentFromOnChain(next, nft, currentPrices, cb);
          result[item.idx] = next;
          continue;
        }
        let next: OpenPosition = { ...item.p };
        next.startUsd = newStartUsd;
        next.netStartUsd = overriddenNetStartUsd(item.p, newStartUsd);
        next.matchedV3TokenId = nft.tokenId.toString();
        if (oldStartUsd > 0) {
          next.supplyTokens = item.p.supplyTokens.map((t) => ({
            ...t,
            startUsd: (t.startUsd / oldStartUsd) * newStartUsd,
          }));
        }
        next = backfillOrphanMeta(next, cb, nft);
        next = overrideCurrentFromOnChain(next, nft, currentPrices, cb);
        // H6: collateral-side PnL only.
        next.netPnlUsd = next.currentUsd - next.startUsd;
        next.netPnlPct = next.startUsd > 0 ? (next.netPnlUsd / next.startUsd) * 100 : 0;
        result[item.idx] = next;
        overriddenCount++;
        warnings.push(
          `[V3 override per-NFT amount-match] ${item.p.id} (NFT #${nft.tokenId}): ` +
            `$${oldStartUsd.toFixed(2)} → $${newStartUsd.toFixed(2)}`,
        );
      }
      itemsWithoutMatch.length = 0;
      itemsWithoutMatch.push(...stillUnmatched);
    }

    if (itemsWithoutMatch.length === 0) continue;

    // PHASE 2: pro-rata fallback for unmatched positions.
    const greedyMatchedNftIds = new Set<string>();
    const matchedHashes = new Set(
      items
        .filter((x) => !itemsWithoutMatch.includes(x))
        .map((x) => (x.p.openHash ?? "").toLowerCase()),
    );
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      if (itemsWithoutMatch.includes(it)) continue;
      const overriddenStart = result[it.idx]?.startUsd;
      if (overriddenStart == null) continue;
      for (const nft of nfts) {
        const cb = v3CostBasis.get(nft.tokenId.toString());
        // Absolute (1 cent) match for FX rounding noise.
        if (cb && Math.abs(cb.netCostBasisUsd - overriddenStart) < 0.01) {
          greedyMatchedNftIds.add(nft.tokenId.toString());
          break;
        }
      }
    }
    let unmatchedAuthTotal = 0;
    let hasAuthData = false;
    for (const nft of nfts) {
      const cb = v3CostBasis.get(nft.tokenId.toString());
      if (!cb || cb.netCostBasisUsd <= 0) continue;
      if (cb.mintTxHash && matchedHashes.has(cb.mintTxHash.toLowerCase())) continue;
      if (greedyMatchedNftIds.has(nft.tokenId.toString())) continue;
      unmatchedAuthTotal += cb.netCostBasisUsd;
      hasAuthData = true;
    }
    if (!hasAuthData || unmatchedAuthTotal <= 0) continue;

    const currentTotalStart = itemsWithoutMatch.reduce((s, x) => s + x.p.startUsd, 0);
    if (currentTotalStart <= 0) continue;

    // H5: always apply pro-rata at the per-NFT level; only skip individually
    // within-tolerance writes (group-sum compare hid compensating per-NFT errors).
    const totalCurrent = itemsWithoutMatch.reduce(
      (s, x) => s + Math.max(0, x.p.currentUsd),
      0,
    );
    let groupApplied = 0;
    for (const x of itemsWithoutMatch) {
      const share =
        totalCurrent > 0
          ? Math.max(0, x.p.currentUsd) / totalCurrent
          : 1 / itemsWithoutMatch.length;
      const newStartUsd = unmatchedAuthTotal * share;
      const oldStartUsd = x.p.startUsd;
      if (
        oldStartUsd > 0 &&
        Math.abs(newStartUsd - oldStartUsd) / oldStartUsd < DISTANCE_TOLERANCE
      ) {
        continue;
      }
      const next: OpenPosition = { ...x.p };
      next.startUsd = newStartUsd;
      next.netStartUsd = overriddenNetStartUsd(x.p, newStartUsd);
      if (oldStartUsd > 0) {
        next.supplyTokens = x.p.supplyTokens.map((t) => ({
          ...t,
          startUsd: (t.startUsd / oldStartUsd) * newStartUsd,
        }));
      }
      // H6: collateral-side PnL only.
      next.netPnlUsd = next.currentUsd - next.startUsd;
      next.netPnlPct = next.startUsd > 0 ? (next.netPnlUsd / next.startUsd) * 100 : 0;
      result[x.idx] = next;
      overriddenCount++;
      groupApplied++;
    }

    if (groupApplied > 0) {
      warnings.push(
        `[V3 override pro-rata] ${key}: oldTotal=$${currentTotalStart.toFixed(2)} → ` +
          `authTotal=$${unmatchedAuthTotal.toFixed(2)} ` +
          `(${groupApplied}/${itemsWithoutMatch.length} unmatched positions adjusted)`,
      );
    }
  }

  return { positions: result, overriddenCount, warnings };
}
