/**
 * PR-2 (2026-05-25): split inflated `claim_rewards` ops в V3 LP когда они
 * на самом деле — `multicall(decreaseLiquidity, collect)`.
 *
 * **Проблема**: классификатор (apps/web/.../classifier.ts:521-572) для V3
 * receives-only ops по-умолчанию метит как `claim_rewards`. Если tx
 * на самом деле `multicall(decreaseLiquidity, collect)` — user получает
 * principal + fees в один движении, всё помечается claim → inflated
 * claimed fee. lex POS-007 example: первый claim "$701", real fee ~\$15
 * (остальное principal с decrease).
 *
 * **Fix**: используя `V3CostBasisResult.withdrawalsByTxHash` (per-tx Σ
 * amounts из DecreaseLiquidity events) — для каждой entry feesClaimedHistory
 * с tx hash match'ующим декрис: subtract principal USD value от entry.usd.
 * Затем Σ new history.usd → новый feesClaimedUsd. Обновляем lifetime/APR.
 *
 * Не требует данных Krystal — работает только из Etherscan event logs.
 * Покрывает кейсы где Krystal неактивен (credits, base chain, и т.д.) +
 * CLOSED positions tax breakdown.
 *
 * Apply ПЕРЕД applyKrystalV3Override (Krystal authoritative override
 * перепишет наши значения если активен — это OK, мы fallback для not-Krystal).
 */

import type { V3CostBasisResult } from "@/lib/v3/liquidity_events";
import type { V3PositionMap } from "@/lib/v3/hook";
import type { OpenPosition } from "./open_positions";
import { findV3Deployments } from "@/lib/v3/chains";
import { v3PositionKey } from "@/lib/v3/hook";

/**
 * WETH/ETH, WBTC/BTC canonicalization. Movement symbols от DeBank часто
 * native (ETH), V3 NFT хранит wrapped (WETH). Сравнение должно совпадать.
 */
function canonicalSymbol(s: string): string {
  const u = s.toUpperCase();
  if (u === "WETH") return "ETH";
  if (u === "WBTC" || u === "TBTC" || u === "CBBTC") return "BTC";
  if (u === "WSOL") return "SOL";
  return u;
}

function processOne(
  base: OpenPosition,
  cb: V3CostBasisResult,
  nftToken0Symbol: string,
  nftToken1Symbol: string,
): OpenPosition {
  if (!cb.withdrawalsByTxHash || cb.withdrawalsByTxHash.size === 0) {
    return base;
  }
  if (base.feesClaimedHistory.length === 0) return base;

  const sym0Canon = canonicalSymbol(nftToken0Symbol);
  const sym1Canon = canonicalSymbol(nftToken1Symbol);

  let totalAdjusted = 0;
  let anyAdjusted = false;

  const newHistory = base.feesClaimedHistory.map((entry) => {
    const w = cb.withdrawalsByTxHash!.get(entry.hash.toLowerCase());
    if (!w) {
      totalAdjusted += entry.usd ?? 0;
      return entry;
    }
    anyAdjusted = true;

    // Per-token: subtract principal amount from each matching tokensReceived.
    // Если movement symbol == NFT side symbol (canon) → это principal portion.
    let principalUsd = 0;
    const newTokens = (entry.tokensReceived ?? []).map((t) => {
      const tSym = canonicalSymbol(t.symbol);
      const pricePerUnit = t.amount > 0 ? t.usd / t.amount : 0;
      let principalAmount = 0;
      if (tSym === sym0Canon) principalAmount = Math.min(t.amount, w.amount0);
      else if (tSym === sym1Canon) principalAmount = Math.min(t.amount, w.amount1);
      if (principalAmount > 0 && pricePerUnit > 0) {
        principalUsd += principalAmount * pricePerUnit;
      }
      const newAmount = Math.max(0, t.amount - principalAmount);
      return {
        ...t,
        amount: newAmount,
        usd: newAmount * pricePerUnit,
      };
    });
    const newEntryUsd = Math.max(0, (entry.usd ?? 0) - principalUsd);
    totalAdjusted += newEntryUsd;

    // Recompute aprPeriod with corrected fee USD.
    const aprPeriod =
      entry.positionUsdAtClaim != null &&
      entry.positionUsdAtClaim > 0 &&
      entry.daysSincePrev != null &&
      entry.daysSincePrev > 0
        ? (newEntryUsd / entry.positionUsdAtClaim) * (365 / entry.daysSincePrev) * 100
        : entry.aprPeriod ?? null;

    return {
      ...entry,
      usd: newEntryUsd,
      tokensReceived: newTokens,
      ...(aprPeriod != null && { aprPeriod }),
    };
  });

  if (!anyAdjusted) return base;

  const newClaimedUsd = totalAdjusted;
  const newLifetime = (base.feesUsd ?? 0) + newClaimedUsd;
  const ageDays = base.ageDays;
  const feeAprLifetime =
    ageDays && ageDays > 0 && base.startUsd > 0 && newLifetime > 0
      ? (newLifetime / base.startUsd) * (365 / ageDays) * 100
      : base.feeAprLifetime;

  return {
    ...base,
    feesClaimedUsd: newClaimedUsd,
    feesClaimedHistory: newHistory,
    feesLifetimeUsd: newLifetime,
    feeAprLifetime,
  };
}

export function applyV3ClaimedFeesSplit(
  positions: readonly OpenPosition[],
  v3PositionMap: V3PositionMap,
  v3CostBasis: ReadonlyMap<string, V3CostBasisResult>,
): OpenPosition[] {
  if (v3PositionMap.size === 0 || v3CostBasis.size === 0) {
    return positions.slice();
  }
  return positions.map((p) => {
    if (!p.matchedV3TokenId) return p;
    const cb = v3CostBasis.get(p.matchedV3TokenId);
    if (!cb) return p;
    // Need NFT token0/token1 symbols for matching. Find via v3PositionMap.
    const deps = findV3Deployments(p.chain, p.protocol.name);
    let nft: ReturnType<V3PositionMap["get"]>[number][number] | undefined;
    for (const dep of deps) {
      const key = v3PositionKey({
        walletId: p.walletId,
        chain: p.chain,
        deploymentId: dep.id,
        symbols: p.supplyTokens.map((t) => t.symbol),
      });
      const arr = v3PositionMap.get(key);
      if (arr) {
        nft = arr.find((n) => n.tokenId.toString() === p.matchedV3TokenId);
        if (nft) break;
      }
    }
    if (!nft) return p;
    return processOne(p, cb, nft.token0.symbol, nft.token1.symbol);
  });
}
