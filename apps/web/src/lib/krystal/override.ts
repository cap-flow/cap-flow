/**
 * Krystal V3 → OpenPosition override.
 *
 * 2026-05-27 (VolnyySanya audit, policy change): Krystal становится PRIMARY
 * для cost-basis side V3 LP — `startUsd`, `openedAt`, `supplyTokens[].startUsd`.
 * Раньше эти поля шли через UCB lot tracker, что для новых кошельков без
 * CEX-синка / cross-wallet связи давало мусор (silent fallback). Krystal
 * индексирует IncreaseLiquidity events напрямую с RPC через `performance.
 * totalDepositValue` и `openedTime` — это on-chain truth, не зависит от
 * наличия CEX-данных или cross-wallet attribution.
 *
 *  | OpenPosition field         | Source                              |
 *  |----------------------------|-------------------------------------|
 *  | supplyTokens[].amount      | krystal.currentTokens[].amount      |
 *  | supplyTokens[].currentUsd  | krystal.currentTokens[].usd         |
 *  | currentUsd                 | krystal.currentUsd                  |
 *  | feesUsd (pending)          | krystal.pendingFeeUsd               |
 *  | feesByToken (pending)      | krystal.pendingFeeTokens            |
 *  | startUsd                   | krystal.totalDepositValue (NEW)     |
 *  | netStartUsd                | krystal.totalDepositValue (NEW)     |
 *  | openedAt / ageDays         | krystal.openedTime (NEW)            |
 *  | supplyTokens[].startUsd    | pro-rata from krystal.providedTokens|
 *  | feesClaimedUsd             | **UCB+PR-2 (НЕ Krystal)**           |
 *  | feesClaimedByToken         | **UCB (НЕ Krystal)**                |
 *  | feesClaimedHistory         | **UCB+PR-2 (НЕ Krystal)**           |
 *  | feesLifetimeUsd            | new pending + UCB claimed           |
 *  | feeApr / feeAprLifetime    | recompute with new startUsd         |
 *  | netPnlUsd / netPnlPct      | krystal.currentUsd − krystal.start  |
 *
 * Что НЕ override'им (нет on-chain analogue):
 *   openHash (DeBank tx hash для UI deep-link), openedInTokens.
 *
 * **Claimed fees ОСТАЮТСЯ UCB+PR-2** — Krystal `tradingFee.claimed` подтверждённо
 * unreliable (lex@ audit 2026-05-25: POS-006/007 real $271/$80 vs Krystal
 * $107/$32). PR-2 split через DecreaseLiquidity events авторитарен. Это
 * разделение НЕ trivial: `totalDepositValue` ≠ `tradingFee.claimed`, разные
 * данные с разной надёжностью — мы используем точную часть, отказываемся
 * от кривой.
 *
 * **Fallback**: если Krystal не вернул `totalDepositValue` / `openedTime`
 * (старые позиции, edge cases), сохраняем UCB значения base.* — `?? base.X`.
 * Это бесшовное degradation, не silent fallback на мусор.
 */

import type { OpenPosition } from "../portfolio/open_positions";
import { isV3LpProtocol } from "../portfolio/open_positions";
import type {
  KrystalTransactionsSummary,
  KrystalV3Summary,
  TokenBreakdown,
} from "./adapter";

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

/**
 * Aggregate COLLECT_FEE history entries по символу для UI breakdown.
 * Используется когда Krystal `/transactions` доступен — суммирует все
 * snятия по каждому token symbol.
 */
function aggregateClaimedByToken(
  history: readonly { tokensReceived?: { symbol: string; amount: number; usd: number }[] }[],
): OpenPosition["feesClaimedByToken"] {
  const acc = new Map<string, { amount: number; usd: number }>();
  for (const entry of history) {
    for (const t of entry.tokensReceived ?? []) {
      const prev = acc.get(t.symbol) ?? { amount: 0, usd: 0 };
      acc.set(t.symbol, {
        amount: prev.amount + t.amount,
        usd: prev.usd + t.usd,
      });
    }
  }
  return Array.from(acc.entries()).map(([symbol, v]) => ({
    symbol,
    amount: v.amount,
    usd: v.usd,
    nativeApr: null,
  }));
}

function overrideOne(
  base: OpenPosition,
  k: KrystalV3Summary,
  txs: KrystalTransactionsSummary | undefined,
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

  // 2026-05-27 (MMaksimuk POS-001/002 audit follow-up): startUsd идёт из
  // Krystal `/transactions` Σ DEPOSIT events (historical at-block USD).
  //
  // Старый источник `k.totalDepositValue` (= /positions.performance.
  // totalDepositValue) оказался unreliable в 2 случаях:
  //   - V4 ARB indexer удваивает providedAmounts (MMaksimuk POS-001 V4:
  //     /positions $3,499 vs /transactions $1,749 = real deposit)
  //   - providedAmounts.value использует CURRENT spot × current balance,
  //     а не historical at-deposit, что для volatile tokens даёт mismatch
  //     (POS-002 COPXon: /positions $373 vs /transactions $425 historical)
  //
  // `/transactions DEPOSIT.totalUsd` использует block-time pricing
  // (oracle/slot0 на момент tx) — это **what user actually paid** byte-в-byte.
  // Подтверждено: MMaksimuk POS-001 single DEPOSIT $1,749 совпадает с
  // user-confirmed DeBank history.
  //
  // Hierarchy:
  //   1. Σ DEPOSIT events из /transactions (PRIMARY — historical, authoritative)
  //   2. k.totalDepositValue (backup — иногда inflated/deflated, но лучше чем ничего)
  //   3. base.startUsd (last resort — UCB lot tracker, может быть мусором)
  //
  // 2026-05-28 (MMaksimuk POS-002 follow-up): для Uniswap V4 фолбэк на
  // `k.totalDepositValue` ОТКЛЮЧЁН. Krystal V4 indexer удваивает
  // `performance.totalDepositValue` И `providedAmounts.balance` (видимо
  // double-counts ModifyLiquidity events на pool + manager). Live probe
  // POS-002 ARB #147480: /positions говорит $3,499, /transactions Σ
  // DEPOSIT даёт правильные $1,749. Если /tx для V4 не пришёл (cache miss
  // / fetch error) — лучше base.startUsd (UCB) чем заведомо inflated 2×.
  const txsHasDeposits = txs != null && txs.depositTotalUsd > 0;
  const isUniswapV4 = (k.protocolKey ?? "").toLowerCase() === "uniswapv4";
  const krystalTotalDepositTrustworthy = !isUniswapV4;
  const newStartUsd = txsHasDeposits
    ? txs!.depositTotalUsd
    : (krystalTotalDepositTrustworthy && k.totalDepositValue != null
        ? k.totalDepositValue
        : base.startUsd);
  const newNetStartUsd = txsHasDeposits
    ? Math.max(0, txs!.depositTotalUsd - (txs!.withdrawTotalUsd ?? 0))
    : (krystalTotalDepositTrustworthy && k.totalDepositValue != null
        ? Math.max(0, k.totalDepositValue - (k.totalWithdrawValue ?? 0))
        : base.netStartUsd);
  // Fallback path: позиция попала сюда через pair-match (Base chain без
  // Etherscan, etc.) — `base.openedAt` происходит от DeBank earliest lp_add
  // op time, который уезжает на месяцы (POS-001 VolnyySanya: 05.03 vs real
  // 18.04). Если Krystal openedTime есть — берём его. Если нет — null,
  // лучше пусто чем misleading.
  const fallbackPath = !base.matchedV3TokenId;
  const newOpenedAt =
    k.openedTime != null ? k.openedTime : fallbackPath ? null : base.openedAt;
  // ageDays: пересчитываем только когда openedAt РЕАЛЬНО поменялся
  // (Krystal дал новый openedTime или fallback path обнулил). Если openedAt
  // не поменялся — сохраняем base.ageDays (тесты опираются на этот invariant).
  // Округляем до 0.1 чтобы UI не показывал "39.52128643518521 дн.".
  const openedAtChanged = newOpenedAt !== base.openedAt;
  const newAgeDays = !openedAtChanged
    ? base.ageDays
    : newOpenedAt != null
      ? Math.round(Math.max(0, (Date.now() / 1000 - newOpenedAt) / 86400) * 10) / 10
      : null;

  // supplyTokens[].startUsd + startAmount: предпочитаем Krystal providedTokens
  // (исторические amounts/USD вошедших токенов). UI колонка «ВНЕСЕНО ТОКЕНОВ»
  // = `startAmount`. UCB lot tracker для нового кошелька даёт мусор (POS-001
  // VolnyySanya: 0.861 WETH + 63.72 USDC вместо реальных 0 WETH + 2000 USDC).
  const providedBySym = new Map<string, TokenBreakdown>();
  for (const t of k.providedTokens ?? []) {
    // NOTE: для providedTokens НЕ фильтруем zero — реальный 0 amount
    // (USDC-only deposit → WETH provided=0) — это валидная информация
    // для UI «Внесено токенов».
    providedBySym.set(t.symbol.toUpperCase(), t);
  }
  const providedSumUsd = Array.from(providedBySym.values()).reduce(
    (s, t) => s + t.usd,
    0,
  );
  // newSupplyWithProvided: переносит startAmount из Krystal providedTokens
  // (net deposit). UCB lot tracker для нового кошелька даёт накопленные
  // amount'ы cross-protocol — не то что реально лежит в позиции. UI колонка
  // «Внесено токенов» = `startAmount`, должна показывать what's deposited
  // into THIS NFT, не cross-aggregate.
  const newSupplyWithProvided = newSupplyPreStart.map((t) => {
    const pt = providedBySym.get(t.symbol.toUpperCase());
    if (!pt) return t;
    return {
      ...t,
      startAmount: pt.amount,
    };
  });
  let newSupply: typeof newSupplyPreStart;
  if (providedSumUsd > 0 && newStartUsd > 0) {
    // Krystal-driven per-token startUsd: каждой supply строке привязываем
    // её provided.usd (canonical pair-match по symbol case-insensitive),
    // потом масштабируем чтобы Σ = newStartUsd (на случай если Krystal
    // providedTokens.usd суммой не равны totalDepositValue из-за rounding).
    const rawByPos = newSupplyWithProvided.map((t) => {
      const pt = providedBySym.get(t.symbol.toUpperCase());
      return pt ? pt.usd : 0;
    });
    const rawSum = rawByPos.reduce((s, x) => s + x, 0);
    newSupply =
      rawSum > 0
        ? newSupplyWithProvided.map((t, i) => ({
            ...t,
            startUsd: (rawByPos[i]! / rawSum) * newStartUsd,
          }))
        : // Нет mapping по symbols (canonicalization mismatch) — fallback
          // на pro-rata от current.
          (() => {
            const totalCur = newSupplyWithProvided.reduce(
              (s, t) => s + (t.currentUsd ?? 0),
              0,
            );
            return totalCur > 0
              ? newSupplyWithProvided.map((t) => ({
                  ...t,
                  startUsd: ((t.currentUsd ?? 0) / totalCur) * newStartUsd,
                }))
              : newSupplyWithProvided;
          })();
  } else {
    // Legacy fallback (Krystal не дал providedTokens.usd): pro-rata по
    // current — сохраняем display invariant Σ startUsd ≈ position.startUsd.
    const totalNewCurrent = newSupplyWithProvided.reduce(
      (s, t) => s + (t.currentUsd ?? 0),
      0,
    );
    newSupply =
      totalNewCurrent > 0 && newStartUsd > 0
        ? newSupplyWithProvided.map((t) => ({
            ...t,
            startUsd: ((t.currentUsd ?? 0) / totalNewCurrent) * newStartUsd,
          }))
        : newSupplyWithProvided;
  }

  // Pending fees — Krystal authoritative (real-time feeGrowth math
  // server-side, matches Uniswap UI). См. lex POS-001: UCB stale $13.84 →
  // Krystal real-time $251.61.
  const newFeesUsd = k.pendingFeeUsd;
  const newFeesByToken = k.pendingFeeTokens.map(toFeeByTokenEntry);

  // Claimed fees: используем Krystal `/transactions` endpoint как PRIMARY
  // source (2026-05-27 VolnyySanya audit follow-up).
  //
  // Krystal endpoint `/v1/positions/{chainId}/{nft}/transactions` отдаёт
  // per-tx COLLECT_FEE events с historical USD prices at block time.
  // Подтверждено byte-в-byte на 3 позициях:
  //   - VolnyySanya POS-001 BASE: $73.14 claimed (matches user's $73.13)
  //   - lex POS-007 ETH: $80.37 claimed (matches memory's "real $80")
  //   - lex POS-006 ARB: $271.02 claimed (matches memory's "real $271")
  //
  // Это **полностью заменяет** обе предыдущие политики:
  //   - UCB+PR-2 split для matched path (был approximate, теперь авторитарен)
  //   - Krystal aggregated `tradingFee.claimed[]` для fallback path
  //     (там indexer lag давал underreport)
  //
  // Если `txs` не пришли (Krystal endpoint не отдал данные / position не
  // найдена в их индексере / network ошибка) → fallback на base.feesClaimed*
  // (UCB+PR-2). Без silent fallback на мусор.
  const hasTxsData = txs != null && txs.claimedHistory.length >= 0;
  const newFeesClaimedUsd = hasTxsData
    ? txs!.claimedTotalUsd
    : base.feesClaimedUsd;
  // 2026-05-27 (PR-K23 follow-up): обогащаем каждый history entry полем
  // `aprPeriod` + `positionUsdAtClaim`. Krystal `/transactions` не отдаёт
  // per-time TVL, поэтому используем `newStartUsd` как аппроксимацию
  // position value (для V3 LP без active rebalance это близко к правде).
  // Formula совпадает с UCB+PR-2 split: (usd/positionUsd) × (365/days) × 100.
  const newFeesClaimedHistory = hasTxsData
    ? txs!.claimedHistory.map((entry) => {
        const out: typeof entry = { ...entry };
        if (newStartUsd > 0) out.positionUsdAtClaim = newStartUsd;
        if (
          entry.daysSincePrev != null &&
          entry.daysSincePrev > 0 &&
          newStartUsd > 0
        ) {
          out.aprPeriod = (entry.usd / newStartUsd) * (365 / entry.daysSincePrev) * 100;
        }
        return out;
      })
    : base.feesClaimedHistory;
  // feesClaimedByToken: derive из последнего COLLECT_FEE entry для UI breakdown,
  // или агрегировать по symbol через всю историю.
  const newFeesClaimedByToken = hasTxsData
    ? aggregateClaimedByToken(txs!.claimedHistory)
    : base.feesClaimedByToken;
  const newFeesLifetimeUsd = newFeesUsd + newFeesClaimedUsd;

  // PnL recompute (collateral-side, H6 invariant — debt не вычитаем).
  // Считаем от НОВОГО startUsd (Krystal authoritative).
  const newPnlUsd = newCurrentUsd - newStartUsd;
  const newPnlPct =
    newStartUsd > 0 ? (newPnlUsd / newStartUsd) * 100 : 0;

  // Fee APR recompute от нового startUsd + нового ageDays.
  const feeApr =
    newAgeDays != null && newAgeDays > 0 && newStartUsd > 0
      ? (newFeesUsd / newStartUsd) * (365 / newAgeDays) * 100
      : null;
  const feeAprLifetime =
    newAgeDays != null && newAgeDays > 0 && newStartUsd > 0 && newFeesLifetimeUsd > 0
      ? (newFeesLifetimeUsd / newStartUsd) * (365 / newAgeDays) * 100
      : null;

  // Bug C fix (2026-05-25 lex@ V3-popup audit): после override
  // `supplyTokens.amount/currentUsd` и `currentUsd` пересчитываем
  // `v3.currentLpUsd`/`impermanentLossUsd`/`pnlUsd`/`pnlPct`.
  //
  // 2026-05-27 (VolnyySanya follow-up): также синхронизируем
  // `v3.depositTokens` и `v3.depositUsd` из Krystal providedTokens +
  // totalDepositValue. UI колонка «Открыто в» = `v3.depositTokens`.
  // Без этого UI показывает старые UCB-derived токены (POS-001 BASE:
  // ETH 0.36 + USDC 951 вместо реальных 0 WETH + 2000 USDC).
  const newV3DepositTokens =
    k.providedTokens.length > 0 && newStartUsd > 0
      ? k.providedTokens.map((t) => ({
          symbol: t.symbol,
          amount: t.amount,
          usdAtDeposit: t.usd,
        }))
      : base.v3?.depositTokens ?? [];
  const newV3DepositUsd = k.totalDepositValue ?? base.v3?.depositUsd ?? 0;

  const newV3 = base.v3
    ? (() => {
        const newCurrentLpUsd = newCurrentUsd;
        const newImpermanentLossUsd = base.v3.hodlUsd - newCurrentLpUsd;
        const newV3PnlUsd = newCurrentLpUsd - newV3DepositUsd;
        const newV3PnlPct =
          newV3DepositUsd > 0
            ? (newV3PnlUsd / newV3DepositUsd) * 100
            : 0;
        return {
          ...base.v3,
          depositTokens: newV3DepositTokens,
          depositUsd: newV3DepositUsd,
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
    // Cost-basis side: Krystal authoritative (если отдал totalDepositValue/
    // openedTime), иначе оставляем UCB значения.
    startUsd: newStartUsd,
    netStartUsd: newNetStartUsd,
    openedAt: newOpenedAt,
    ageDays: newAgeDays,
    netPnlUsd: newPnlUsd,
    netPnlPct: newPnlPct,
    feesUsd: newFeesUsd,
    feesByToken: newFeesByToken,
    // feesClaimedUsd / feesClaimedByToken / feesClaimedHistory:
    // Krystal `/transactions` endpoint authoritative (если доступен).
    // Иначе fallback на UCB+PR-2 (base.feesClaimed*).
    feesClaimedUsd: newFeesClaimedUsd,
    feesClaimedByToken: newFeesClaimedByToken,
    feesClaimedHistory: newFeesClaimedHistory,
    feesLifetimeUsd: newFeesLifetimeUsd,
    feeApr,
    feeAprLifetime,
    ...(newV3 && { v3: newV3 }),
    // Krystal — authoritative источник для current state + cost basis V3 LP.
    // После policy change (2026-05-27) coverage gate badge не нужен —
    // Krystal закрывает и current и historical через RPC-derived данные.
    coverageIncomplete: false,
    // Fallback path: если matchedV3TokenId не был установлен (Base chain
    // где Etherscan v2 unsupported / Alchemy 403) — проставляем его сейчас,
    // чтобы downstream UI / overrides работали как обычно.
    ...(base.matchedV3TokenId
      ? {}
      : { matchedV3TokenId: k.tokenId }),
    // Fallback path без Krystal openedTime: чистим связанные historical
    // поля (openHash, openedInTokens) — base.* из DeBank earliest lp_add
    // op, которое уехало во времени.
    ...(fallbackPath && k.openedTime == null
      ? { openHash: null, openedInTokens: [] }
      : {}),
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
  transactionsByTokenId?: ReadonlyMap<string, KrystalTransactionsSummary>,
): OpenPosition[] {
  if (krystalByTokenId.size === 0) {
    return positions.slice();
  }
  const allEntries = Array.from(krystalByTokenId.values());
  return positions.map((p) => {
    if (p.matchedV3TokenId) {
      const k = krystalByTokenId.get(p.matchedV3TokenId);
      if (!k) return p;
      const txs = transactionsByTokenId?.get(p.matchedV3TokenId);
      return overrideOne(p, k, txs);
    }
    const wallet = walletAddressById?.get(p.walletId);
    const k = tryFallbackMatch(p, wallet, allEntries);
    if (!k) return p;
    const txs = transactionsByTokenId?.get(k.tokenId);
    return overrideOne(p, k, txs);
  });
}
