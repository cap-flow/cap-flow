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
import { isV3LpProtocol } from "../portfolio/open_positions";
import type { KrystalV3Summary, TokenBreakdown } from "./adapter";

/**
 * WETH/ETH, WBTC/BTC canonicalization для pair-match fallback.
 * Krystal NFT хранит wrapped (WETH), Capflow supplyTokens иногда native (ETH).
 */
function canonicalSymbol(s: string): string {
  const u = s.toUpperCase();
  if (u === "WETH") return "ETH";
  if (u === "WBTC" || u === "TBTC" || u === "CBBTC") return "BTC";
  if (u === "WSOL") return "SOL";
  return u;
}

function sortedCanonPair(a: string, b: string): string {
  const ca = canonicalSymbol(a);
  const cb = canonicalSymbol(b);
  return ca < cb ? `${ca}|${cb}` : `${cb}|${ca}`;
}

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
  const newSupplyPreStart = base.supplyTokens.map((t) => {
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

  // 2026-05-25 (Derbent21 audit POS-002): rebalance supplyTokens.startUsd
  // pro-rata по новому currentUsd. Раньше:
  //   1) Phase J runs first, NFT at-range-boundary → amount0Current=0.27,
  //      amount1Current=0 → rebalance: WETH start = $515, USDC start = $0
  //   2) Krystal override runs later → corrects amount/currentUsd
  //      (real-time 0.20 WETH + 159 USDC), но startUsd preserved → итог
  //      WETH start $515 (100%), USDC start $0 (0%) — misleading split
  // Теперь: используем новый currentUsd для rebalance — отражает реальную
  // композицию позиции на момент Krystal data.
  const totalNewCurrent = newSupplyPreStart.reduce(
    (s, t) => s + (t.currentUsd ?? 0),
    0,
  );
  const newSupply =
    totalNewCurrent > 0 && base.startUsd > 0
      ? newSupplyPreStart.map((t) => ({
          ...t,
          startUsd: ((t.currentUsd ?? 0) / totalNewCurrent) * base.startUsd,
        }))
      : newSupplyPreStart;

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

  // Bug C fix (2026-05-25 lex@ V3-popup audit): после override
  // `supplyTokens.amount/currentUsd` и `currentUsd` пересчитываем
  // `v3.currentLpUsd`/`impermanentLossUsd`/`pnlUsd`/`pnlPct`.
  // hodlUsd НЕ трогаем — depositTokens × currentPrices, не зависит
  // от Krystal-override.
  const newV3 = base.v3
    ? (() => {
        const newCurrentLpUsd = newCurrentUsd;
        const newImpermanentLossUsd = base.v3.hodlUsd - newCurrentLpUsd;
        const newV3PnlUsd = newCurrentLpUsd - base.v3.depositUsd;
        const newV3PnlPct =
          base.v3.depositUsd > 0
            ? (newV3PnlUsd / base.v3.depositUsd) * 100
            : 0;
        return {
          ...base.v3,
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
    // feesClaimedUsd / feesClaimedByToken / feesClaimedHistory — НЕ trump
    // UCB. Оставляем base.* как есть.
    feesLifetimeUsd: newFeesLifetimeUsd,
    feeApr,
    feeAprLifetime,
    ...(newV3 && { v3: newV3 }),
    // Bug F (O_lll_ABC_lll_O audit 2026-05-25): Krystal — authoritative
    // источник для current state. Если override применился, ⚠ "coverage
    // incomplete" badge становится бесполезным (current/fees уже корректные,
    // missing только historical mint date). Чистим флаг чтобы UX не пугал.
    coverageIncomplete: false,
    // Fallback path: если matchedV3TokenId не был установлен (Base chain
    // где Etherscan v2 unsupported / Alchemy 403) — проставляем его сейчас,
    // чтобы downstream UI / overrides работали как обычно.
    ...(base.matchedV3TokenId
      ? {}
      : { matchedV3TokenId: k.tokenId }),
    // 2026-05-26 (VolnyySanya POS-001 Base audit): если pair-match fallback
    // сработал БЕЗ cb данных (нет Etherscan IncreaseLiquidity events —
    // типично для Base без Alchemy Pro plan), reality openedAt/openHash
    // из chain unknown. DeBank's earliest lp_add op попадает в position
    // как «open» и daтa уезжает на месяцы вперёд (POS-001 system 05.03 vs
    // real 18.04 — 44 дня). Лучше null → UI «—» чем misleading date.
    //
    // Условие: pair-match fallback (base.matchedV3TokenId был null), cb
    // нет (мы знаем по тому что мы PRIMARY override path для этой
    // позиции). Чистим openedAt/openHash/ageDays/openedInTokens.
    ...(base.matchedV3TokenId
      ? {}
      : {
          openedAt: null,
          openHash: null,
          ageDays: null,
          openedInTokens: [],
        }),
  };
}

/**
 * Pair-match fallback: для V3 LP позиций без matchedV3TokenId (Base chain,
 * где Etherscan v2 не поддерживает chain и Alchemy V3 cost-basis path
 * 403'ит) пытаемся найти Krystal-запись по (ownerAddress, chainCode,
 * sortedCanonPair). Применяем override только если match уникальный.
 *
 * Без owner address (legacy callers без map'а) фоллбэк выключается —
 * pair alone слишком ambiguous (несколько wallet'ов могут держать тот же
 * пул на той же цепи).
 */
function tryFallbackMatch(
  p: OpenPosition,
  walletAddress: string | undefined,
  krystalEntries: readonly KrystalV3Summary[],
): KrystalV3Summary | null {
  if (!walletAddress) return null;
  if (!isV3LpProtocol(p.protocol.name)) return null;
  if (p.supplyTokens.length !== 2) return null;
  const owner = walletAddress.toLowerCase();
  const wantChain = p.chain.toLowerCase();
  const wantPair = sortedCanonPair(
    p.supplyTokens[0]!.symbol,
    p.supplyTokens[1]!.symbol,
  );
  const matches = krystalEntries.filter((k) => {
    if (k.ownerAddress !== owner) return false;
    if (k.chainCode.toLowerCase() !== wantChain) return false;
    if (k.status === "CLOSED") return false;
    return sortedCanonPair(k.pair[0], k.pair[1]) === wantPair;
  });
  if (matches.length !== 1) return null;
  return matches[0]!;
}

/**
 * Apply Krystal override на все V3 LP positions.
 * Primary path: match по `matchedV3TokenId`.
 * Fallback path: для positions без matchedV3TokenId — match по
 * (walletAddress, chain, pair) если walletAddressById предоставлен и
 * Krystal вернул ровно одну подходящую запись (см. tryFallbackMatch).
 *
 * Pure function — возвращает новый массив, не мутирует input.
 */
export function applyKrystalV3Override(
  positions: readonly OpenPosition[],
  krystalByTokenId: ReadonlyMap<string, KrystalV3Summary>,
  walletAddressById?: ReadonlyMap<string, string>,
): OpenPosition[] {
  if (krystalByTokenId.size === 0) {
    return positions.slice();
  }
  const allEntries = Array.from(krystalByTokenId.values());
  return positions.map((p) => {
    if (p.matchedV3TokenId) {
      const k = krystalByTokenId.get(p.matchedV3TokenId);
      if (!k) return p;
      return overrideOne(p, k);
    }
    const wallet = walletAddressById?.get(p.walletId);
    const k = tryFallbackMatch(p, wallet, allEntries);
    if (!k) return p;
    return overrideOne(p, k);
  });
}
