/**
 * PR-K3: Krystal V3 → OpenPosition override.
 *
 * Krystal authoritative ТОЛЬКО для real-time current state V3 NFT.
 * Claimed fees / history ОСТАЮТСЯ UCB + PR-2 split — потому что Krystal
 * `tradingFee.claimed` оказался ненадёжным (lex@ audit 2026-05-25:
 * POS-006/007 Krystal showed $107/$32, реальные Etherscan totals $271/$80).
 *
 *  | OpenPosition field         | Source                              |
 *  |----------------------------|-------------------------------------|
 *  | supplyTokens[].amount      | krystal.currentTokens[].amount      |
 *  | supplyTokens[].currentUsd  | krystal.currentTokens[].usd         |
 *  | currentUsd                 | krystal.currentUsd                  |
 *  | feesUsd (pending)          | krystal.pendingFeeUsd               |
 *  | feesByToken (pending)      | krystal.pendingFeeTokens            |
 *  | feesClaimedUsd             | **UCB+PR-2 (НЕ Krystal)**           |
 *  | feesClaimedByToken         | **UCB (НЕ Krystal)**                |
 *  | feesClaimedHistory         | **UCB+PR-2 (НЕ Krystal)**           |
 *  | feesLifetimeUsd            | new pending + UCB claimed           |
 *  | feeApr / feeAprLifetime    | recompute with new pending + UCB    |
 *  | netPnlUsd / netPnlPct      | currentUsd_krystal − startUsd_UCB   |
 *
 * Cost-basis side (UCB authoritative для cross-protocol):
 *   startUsd, netStartUsd, openedAt, openHash, ageDays,
 *   supplyTokens[].startUsd, openedInTokens.
 *
 * **Pre-PR-K7 (revert)**: claimed override + Bug B history scaling сломали
 * корректные UCB entries (lex POS-007 real $80 → отображалось $32, POS-006
 * real $271 → $107). Krystal divisor оказался unreliable, и pro-rata scale
 * с ним амплифицировал ошибку. PR-2 split уже фиксит inflated UCB entries
 * через DecreaseLiquidity events — Krystal претендует на эту же роль но
 * хуже, поэтому полностью отказываемся.
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

  // Pending fees — Krystal authoritative (real-time feeGrowth math
  // server-side, matches Uniswap UI). См. lex POS-001: UCB stale $13.84 →
  // Krystal real-time $251.61.
  const newFeesUsd = k.pendingFeeUsd;
  const newFeesByToken = k.pendingFeeTokens.map(toFeeByTokenEntry);

  // Claimed fees + history — KEEP UCB+PR-2 значения. Krystal оказался
  // unreliable для claimed total (lex POS-007 real $80 vs Krystal $32,
  // POS-006 real $271 vs Krystal $107). PR-2 split через DecreaseLiquidity
  // events уже фиксит inflated UCB entries.
  const newFeesClaimedUsd = base.feesClaimedUsd;
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
    // feesClaimedUsd / feesClaimedByToken / feesClaimedHistory — НЕ trump
    // UCB. Оставляем base.* как есть.
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
