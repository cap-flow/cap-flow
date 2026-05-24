/**
 * PR-K3: Krystal V3 → OpenPosition override (current state authoritative,
 * cost basis остаётся UCB).
 *
 * Применяется в `useComputedPositions` после `applyV3CostBasisOverride` /
 * Phase J `overrideCurrentFromOnChain`. Если Krystal Map имеет summary для
 * `position.matchedV3TokenId` — current-state поля overrride'ятся:
 *
 *  | OpenPosition field         | Source                              |
 *  |----------------------------|-------------------------------------|
 *  | supplyTokens[].amount      | krystal.currentTokens[].amount      |
 *  | supplyTokens[].currentUsd  | krystal.currentTokens[].usd         |
 *  | currentUsd                 | krystal.currentUsd                  |
 *  | feesUsd                    | krystal.pendingFeeUsd               |
 *  | feesByToken                | krystal.pendingFeeTokens            |
 *  | feesClaimedUsd             | krystal.claimedFeeUsd               |
 *  | feesClaimedByToken         | krystal.claimedFeeTokens            |
 *  | feesLifetimeUsd            | pending + claimed                   |
 *  | feeApr / feeAprLifetime    | recompute from new fees + startUsd  |
 *  | netPnlUsd / netPnlPct      | currentUsd − startUsd               |
 *
 * Cost-basis fields НЕ трогаются (UCB authoritative для cross-protocol):
 *   startUsd, netStartUsd, openedAt, openHash, ageDays,
 *   supplyTokens[].startUsd, openedInTokens.
 *
 * **Что решает на проде** (lex@mail.ru audit 2026-05-24):
 *  - POS-007 claimed $778.76 → ~$32.80 (баг #1 collect-vs-decrease bypass)
 *  - POS-006 claimed $261.69 → ~$108.04 (same)
 *  - Все 6 NFT pending fees от Krystal real-time feeGrowth math (matches
 *    Uniswap UI ровно как наш PR-1b, но БЕЗ нашего multicall complexity)
 */

import type { OpenPosition } from "../portfolio/open_positions";
import type { KrystalV3Summary, TokenBreakdown } from "./adapter";

function toFeeByTokenEntry(
  t: TokenBreakdown,
): OpenPosition["feesByToken"][number] {
  return {
    symbol: t.symbol,
    amount: t.amount,
    usd: t.usd,
    nativeApr: null,
  };
}

function overrideOne(
  base: OpenPosition,
  k: KrystalV3Summary,
): OpenPosition {
  // Override per-token current state. Сохраняем порядок исходных supplyTokens
  // (UI зависит от него), match по symbol case-insensitive.
  const krystalBySym = new Map<string, TokenBreakdown>();
  for (const t of k.currentTokens) {
    krystalBySym.set(t.symbol.toUpperCase(), t);
  }
  const newSupply = base.supplyTokens.map((t) => {
    const kt = krystalBySym.get(t.symbol.toUpperCase());
    if (!kt) return t;
    return {
      ...t,
      amount: kt.amount,
      currentUsd: kt.usd,
    };
  });

  // currentUsd — берём krystal authoritative (включает все nft tokens, не
  // только те что в supplyTokens — на случай если Krystal видит токены
  // которых нет в нашем supply list).
  const newCurrentUsd = k.currentUsd;

  // Fees: pending + claimed from Krystal.
  const newFeesUsd = k.pendingFeeUsd;
  const newFeesByToken = k.pendingFeeTokens.map(toFeeByTokenEntry);
  const newFeesClaimedUsd = k.claimedFeeUsd;
  const newFeesClaimedByToken = k.claimedFeeTokens.map(toFeeByTokenEntry);
  const newFeesLifetimeUsd = newFeesUsd + newFeesClaimedUsd;

  // PnL recompute (collateral-side, H6 invariant — debt не вычитаем).
  const newPnlUsd = newCurrentUsd - base.startUsd;
  const newPnlPct =
    base.startUsd > 0 ? (newPnlUsd / base.startUsd) * 100 : 0;

  // Fee APR recompute с новыми числами (cost basis startUsd unchanged).
  const ageDays = base.ageDays;
  const feeApr =
    ageDays && ageDays > 0 && base.startUsd > 0
      ? (newFeesUsd / base.startUsd) * (365 / ageDays) * 100
      : null;
  const feeAprLifetime =
    ageDays && ageDays > 0 && base.startUsd > 0 && newFeesLifetimeUsd > 0
      ? (newFeesLifetimeUsd / base.startUsd) * (365 / ageDays) * 100
      : null;

  return {
    ...base,
    supplyTokens: newSupply,
    currentUsd: newCurrentUsd,
    netPnlUsd: newPnlUsd,
    netPnlPct: newPnlPct,
    feesUsd: newFeesUsd,
    feesByToken: newFeesByToken,
    feesClaimedUsd: newFeesClaimedUsd,
    feesClaimedByToken: newFeesClaimedByToken,
    feesLifetimeUsd: newFeesLifetimeUsd,
    feeApr,
    feeAprLifetime,
  };
}

/**
 * Apply Krystal override на все V3 LP positions с matchedV3TokenId.
 * Pure function — возвращает новый массив, не мутирует input.
 */
export function applyKrystalV3Override(
  positions: readonly OpenPosition[],
  krystalByTokenId: ReadonlyMap<string, KrystalV3Summary>,
): OpenPosition[] {
  if (krystalByTokenId.size === 0) {
    return positions.slice();
  }
  return positions.map((p) => {
    if (!p.matchedV3TokenId) return p;
    const k = krystalByTokenId.get(p.matchedV3TokenId);
    if (!k) return p;
    return overrideOne(p, k);
  });
}
