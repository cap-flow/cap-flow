/**
 * PR-2 (2026-05-25): split inflated `claim_rewards` ops в V3 LP когда они
 * на самом деле — `multicall(decreaseLiquidity, collect)`.
 *
 * Перенесено из apps/web/src/lib/portfolio/v3_claimed_fees_split.ts (порт
 * V3-операций в серверный движок, 2026-06-12). Единственная адаптация:
 * вместо прямого web-импорта `findV3Deployments` функция принимает
 * `resolveDeploymentIds(chain, protocolName) → string[]` — тот же резолвер,
 * что у `applyV3CostBasisOverride` (на сервере его даёт V3EnrichmentSource,
 * на клиенте — обёртка над findV3Deployments). Web re-export'ит отсюда.
 *
 * **Проблема**: классификатор для V3 receives-only ops по-умолчанию метит
 * как `claim_rewards`. Если tx на самом деле `multicall(decreaseLiquidity,
 * collect)` — user получает principal + fees в одном движении, всё
 * помечается claim → inflated claimed fee. lex POS-007: первый claim
 * "$701", real fee ~$15 (остальное principal с decrease).
 *
 * **Fix**: используя `V3CostBasisResult.withdrawalsByTxHash` (per-tx Σ
 * amounts из DecreaseLiquidity events) — для каждой entry feesClaimedHistory
 * с tx hash match'ующим декрис: subtract principal USD value от entry.usd.
 * Затем Σ new history.usd → новый feesClaimedUsd. Обновляем lifetime/APR.
 *
 * Не требует данных Krystal — работает только из Etherscan event logs.
 * Apply ПЕРЕД applyKrystalV3Override (Krystal authoritative override
 * перепишет наши значения если активен — это OK, мы fallback для not-Krystal).
 */

import {
  v3PositionKey,
  type V3CostBasisResult,
  type V3Position,
  type V3PositionMap,
} from "./v3_types.js";
import type { OpenPosition } from "./open_positions.js";

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

/**
 * Recompute feesClaimedUsd / feesLifetimeUsd / feeAprLifetime после
 * любого изменения feesClaimedHistory.
 */
function rebuildTotals(
  base: OpenPosition,
  newHistory: OpenPosition["feesClaimedHistory"],
): OpenPosition {
  const newClaimedUsd = newHistory.reduce((s, e) => s + (e.usd ?? 0), 0);
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

function processOne(
  base: OpenPosition,
  cb: V3CostBasisResult,
  nftToken0Symbol: string,
  nftToken1Symbol: string,
): OpenPosition {
  if (base.feesClaimedHistory.length === 0) {
    return base;
  }

  // PR-3 (2026-05-25): drop pre-mint entries. Authoritative mint time =
  // cb.mintBlockTime (DeBank openedTime может быть временем закрытия
  // предыдущей NFT той же пары — lex POS-007).
  const preMintFiltered =
    cb.mintBlockTime != null
      ? base.feesClaimedHistory.filter((e) => e.time >= cb.mintBlockTime!)
      : base.feesClaimedHistory;
  const droppedPreMint = preMintFiltered.length !== base.feesClaimedHistory.length;

  // Если withdrawalsByTxHash пуст — нечего split'ить per-tx. Но если мы
  // удалили pre-mint entries — нужно пересчитать totals и вернуть position
  // с очищенной history.
  if (!cb.withdrawalsByTxHash || cb.withdrawalsByTxHash.size === 0) {
    if (!droppedPreMint) return base;
    return rebuildTotals(base, preMintFiltered);
  }

  const sym0Canon = canonicalSymbol(nftToken0Symbol);
  const sym1Canon = canonicalSymbol(nftToken1Symbol);

  let totalAdjusted = 0;
  let anyAdjusted = droppedPreMint;

  const newHistory = preMintFiltered.map((entry) => {
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
  resolveDeploymentIds: (chain: string, protocolName: string) => string[],
): OpenPosition[] {
  if (v3PositionMap.size === 0 || v3CostBasis.size === 0) {
    return positions.slice();
  }
  return positions.map((p) => {
    if (!p.matchedV3TokenId) return p;
    const cb = v3CostBasis.get(p.matchedV3TokenId);
    if (!cb) return p;
    // Need NFT token0/token1 symbols for matching. Find via v3PositionMap.
    const depIds = resolveDeploymentIds(p.chain, p.protocol.name);
    let nft: V3Position | undefined;
    for (const depId of depIds) {
      const key = v3PositionKey({
        walletId: p.walletId,
        chain: p.chain,
        deploymentId: depId,
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
