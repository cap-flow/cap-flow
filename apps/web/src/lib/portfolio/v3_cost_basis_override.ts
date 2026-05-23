/**
 * Post-process для V3 LP позиций: override startUsd через authoritative
 * cumulative cost basis из Alchemy `IncreaseLiquidity` events.
 *
 * **Решает Проблему #2 из аудита**: DeBank API возвращает только первый
 * mint NFT, не отдаёт `increaseLiquidity` calls. POS-001 XAUt пример:
 * live $162 vs DeBank-deposit $57 (3× difference).
 *
 * Алгоритм:
 *   1. Для каждой OpenPosition с V3 LP — найти соответствующие NFT
 *      (live tokenId через v3PositionMap)
 *   2. Sum cumulative cost basis из v3CostBasis Map (по nftTokenId)
 *   3. Если authoritative total отличается от DeBank-видимой mint suma
 *      больше чем на `DISTANCE_TOLERANCE` — override startUsd на authoritative
 *   4. Pro-rata distribute если в группе несколько NFT
 *
 * Возвращает новый массив OpenPosition (не мутирует оригинальный).
 */

/**
 * L4 (2026-05-14): единая константа для V3-override tolerance.
 *
 * Pre-L4 в коде разбросаны hard-coded `< 0.01` (4 места) с inline
 * комментариями вроде «< 5% diff» — расхождение между текстом и
 * реальным значением (1%). Это путало contributors при попытках
 * подкрутить параметр.
 *
 * 1% — реально подобранное значение (см. POS-002 на Alex 2026-05-08:
 * $475 missing на $14,560 = 3.26%, под 5% threshold проскакивало →
 * cost basis улетал). Tolerance держим узким, потому что
 * authoritative-source Alchemy obyčно точна до центов.
 */
const DISTANCE_TOLERANCE = 0.01;

import { findV3Deployments } from "@/lib/v3/chains";
import { v3PositionKey, type V3PositionMap } from "@/lib/v3/hook";
import type { V3CostBasisResult } from "@/lib/v3/liquidity_events";
import type { V3Position } from "@/lib/v3/positions";
import type { OpenPosition } from "./open_positions";

/**
 * Orphan-NFT recovery helper: применяется к любой OpenPosition с
 * `coverageIncomplete=true`, для которой V3CostBasisHook через on-chain
 * Etherscan/Alchemy logs предоставил cb.mintBlockTime + tokenId.
 *
 * Снимает flag, backfill'ит openedAt/openHash/ageDays/openedInTokens.
 * Используется в обеих branch'ах override path (skip-because-close AND
 * actually-overridden).
 */
function backfillOrphanMeta(
  base: OpenPosition,
  cb: V3CostBasisResult,
  nft: V3Position,
): OpenPosition {
  if (!base.coverageIncomplete) return base;
  if (cb.mintBlockTime === undefined) return base;
  const now = Math.floor(Date.now() / 1000);
  const ageDays = Math.max(0, Math.floor((now - cb.mintBlockTime) / 86_400));
  // UCB Phase H (Task #41, 2026-05-23): после backfill orphan'а ageDays стал
  // известен → recompute fee APR (раньше buildOne ставил feeApr=null для
  // coverageIncomplete=true → даже после backfill UI показывал «—»).
  // Формула совпадает с buildOne: (feesUsd / startUsd) × (365 / ageDays) × 100.
  // feesLifetimeUsd аналогично для feeAprLifetime.
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
    openedInTokens: [
      { symbol: nft.token0.symbol, amount: cb.totalDeposited0 },
      { symbol: nft.token1.symbol, amount: cb.totalDeposited1 },
    ],
  };
}

interface OverrideResult {
  positions: OpenPosition[];
  /** Diagnostic: сколько positions было переопределено. */
  overriddenCount: number;
  /** Diagnostic: groups с warning'ом. */
  warnings: string[];
}

export function applyV3CostBasisOverride(
  positions: readonly OpenPosition[],
  v3PositionMap: V3PositionMap,
  v3CostBasis: Map<string, V3CostBasisResult>,
): OverrideResult {
  const result: OpenPosition[] = positions.map((p) => p);
  const warnings: string[] = [];
  let overriddenCount = 0;

  if (v3PositionMap.size === 0 || v3CostBasis.size === 0) {
    return { positions: result, overriddenCount: 0, warnings: [] };
  }

  // Группируем positions по v3PositionKey (= walletId|chain|deploymentId|sortedSymbols).
  type GroupItem = { p: OpenPosition; idx: number };
  const groups = new Map<string, GroupItem[]>();

  for (let idx = 0; idx < result.length; idx++) {
    const p = result[idx]!;
    // Используем protocol.name → findV3Deployments чтобы детектить V3, а не
    // p.v3, потому что upstream buildV3Details может вернуть null для
    // вторичных positions из-за consumedMintHashes dedup'а — но для
    // override'а startUsd нам всё равно нужно их обрабатывать.
    const deps = findV3Deployments(p.chain, p.protocol.name);
    if (deps.length === 0) continue;
    for (const dep of deps) {
      const key = v3PositionKey({
        walletId: p.walletId,
        chain: p.chain,
        deploymentId: dep.id,
        symbols: p.supplyTokens.map((t) => t.symbol),
      });
      if (!v3PositionMap.has(key)) continue;
      const arr = groups.get(key) ?? [];
      arr.push({ p, idx });
      groups.set(key, arr);
      break;
    }
  }

  /**
   * Build mintTxHash → V3CostBasisResult lookup для per-NFT precision match'а.
   * mintTxHash = earliest IncreaseLiquidity event txHash = mint tx,
   * который === OpenPosition.openHash для V3 NFT.
   */
  const byMintHash = new Map<string, V3CostBasisResult>();
  for (const cb of v3CostBasis.values()) {
    if (cb.mintTxHash) byMintHash.set(cb.mintTxHash.toLowerCase(), cb);
  }

  for (const [key, items] of groups) {
    const nfts = v3PositionMap.get(key) ?? [];
    if (nfts.length === 0) continue;

    // ──────────────────────────────────────────────────────────────────
    // PHASE 1: per-NFT precision via openHash → mintTxHash match.
    // Для каждой OpenPosition в группе пытаемся найти ИМЕННО её NFT
    // через хеш mint tx. Если match есть — используем `netCostBasisUsd`
    // конкретно этого NFT (а не pro-rata от group total).
    //
    // КРИТИЧНО: пропускаем hash-match для OpenPositions с дублирующимся
    // openHash в группе — DeBank иногда возвращает один и тот же mint tx
    // для двух разных NFT (видимо из-за multicall в одной транзакции, или
    // из-за того что DeBank возвращает только один lp_add op). В таком
    // случае hash-match ambiguous → лучше fallback на Phase 1.5
    // (amount-match по supplyTokens).
    // ──────────────────────────────────────────────────────────────────
    const openHashCount = new Map<string, number>();
    for (const x of items) {
      const oh = (x.p.openHash ?? "").toLowerCase();
      if (!oh) continue;
      openHashCount.set(oh, (openHashCount.get(oh) ?? 0) + 1);
    }
    const itemsWithoutMatch: typeof items = [];
    const matchedTotalAuth: number[] = [];
    for (const x of items) {
      const oh = (x.p.openHash ?? "").toLowerCase();
      // Если openHash дублируется в группе — hash-match не уникален,
      // sкипаем в Phase 1.5 (amount-match по token amounts).
      const isAmbiguous = oh && (openHashCount.get(oh) ?? 0) > 1;
      const cb = oh && !isAmbiguous ? byMintHash.get(oh) : undefined;
      if (cb && cb.netCostBasisUsd > 0) {
        const oldStartUsd = x.p.startUsd;
        const newStartUsd = cb.netCostBasisUsd;
        // NFT lookup для backfillOrphanMeta (нужны token0/token1 symbols).
        const nftForCb = nfts.find(
          (n) => n.tokenId.toString() === cb.tokenId.toString(),
        );
        if (oldStartUsd > 0 && Math.abs(newStartUsd - oldStartUsd) / oldStartUsd < DISTANCE_TOLERANCE) {
          let next: OpenPosition = {
            ...x.p,
            matchedV3TokenId: cb.tokenId.toString(),
          };
          if (nftForCb) next = backfillOrphanMeta(next, cb, nftForCb);
          result[x.idx] = next;
          matchedTotalAuth.push(newStartUsd);
          continue;
        }
        let next: OpenPosition = { ...x.p };
        next.startUsd = newStartUsd;
        next.matchedV3TokenId = cb.tokenId.toString();
        if (oldStartUsd > 0) {
          next.supplyTokens = x.p.supplyTokens.map((t) => ({
            ...t,
            startUsd: (t.startUsd / oldStartUsd) * newStartUsd,
          }));
        }
        if (nftForCb) next = backfillOrphanMeta(next, cb, nftForCb);
        // H6: do NOT subtract currentDebtUsd. PnL is the change in
        // collateral value only; debt is a separate liability tracked
        // via `currentDebtUsd`. Subtracting it here double-counts the
        // loan against the user (the cash they received is sitting in
        // their wallet, not lost to PnL).
        next.netPnlUsd = next.currentUsd - next.startUsd;
        next.netPnlPct =
          next.startUsd > 0 ? (next.netPnlUsd / next.startUsd) * 100 : 0;
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

    // Если все позиции в группе уже сматчились по openHash — готово.
    if (itemsWithoutMatch.length === 0) continue;

    // ──────────────────────────────────────────────────────────────────
    // PHASE 1.5: greedy match by current token amounts.
    // Если openHash не сработал (DeBank часто возвращает не оригинальный
    // mint, а более поздний increaseLiquidity), пробуем сматчить каждую
    // OpenPosition с конкретной NFT по близости amount0/amount1Current
    // против supplyTokens.amount. Это per-NFT precision без зависимости
    // от openHash (который может быть нестабилен).
    // ──────────────────────────────────────────────────────────────────
    const matchedHashesPhase1 = new Set(
      items
        .filter((x) => !itemsWithoutMatch.includes(x))
        .map((x) => (x.p.openHash ?? "").toLowerCase()),
    );
    // Доступные NFT (не привязанные в Phase 1).
    const availableNfts = nfts.filter((nft) => {
      const cb = v3CostBasis.get(nft.tokenId.toString());
      if (!cb) return true;
      if (cb.mintTxHash && matchedHashesPhase1.has(cb.mintTxHash.toLowerCase())) {
        return false;
      }
      return true;
    });
    if (availableNfts.length > 0 && itemsWithoutMatch.length > 0) {
      // Build per-(item, nft) "distance" по amount proximity (relative).
      // Меньше = ближе. Используем relative diff чтобы 0.001 PAXG vs 0.1 PAXG
      // не доминировался USDC амплитудой.
      type Pair = { itemIdx: number; nftIdx: number; dist: number };
      const pairs: Pair[] = [];
      for (let i = 0; i < itemsWithoutMatch.length; i++) {
        const x = itemsWithoutMatch[i]!;
        // OpenPosition.supplyTokens — массив токенов с .symbol и .amount.
        // V3Position имеет token0/token1 + amount0Current/amount1Current.
        const supplyBySym = new Map<string, number>();
        for (const t of x.p.supplyTokens) {
          // Симметрично normalize'им для match'а с V3Position.token0/1.symbol.
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
          // Relative L1 distance: учитываем оба токена, нормализуя на max.
          const d0 = (a0 + n0) > 0 ? Math.abs(a0 - n0) / Math.max(a0, n0, 1e-9) : 0;
          const d1 = (a1 + n1) > 0 ? Math.abs(a1 - n1) / Math.max(a1, n1, 1e-9) : 0;
          pairs.push({ itemIdx: i, nftIdx: j, dist: d0 + d1 });
        }
      }
      // Greedy assignment: sort pairs ascending by distance, assign first
      // available pair, mark consumed.
      pairs.sort((a, b) => a.dist - b.dist);
      const itemConsumed = new Set<number>();
      const nftConsumed = new Set<number>();
      const greedyMatched: { item: typeof items[number]; nft: typeof nfts[number] }[] = [];
      for (const p of pairs) {
        if (itemConsumed.has(p.itemIdx) || nftConsumed.has(p.nftIdx)) continue;
        // Cap distance threshold: 0.5 (50% relative diff per token = ok,
        // больше — вероятно несоответствующий match, лучше pro-rata).
        if (p.dist > 1.0) break;
        itemConsumed.add(p.itemIdx);
        nftConsumed.add(p.nftIdx);
        greedyMatched.push({
          item: itemsWithoutMatch[p.itemIdx]!,
          nft: availableNfts[p.nftIdx]!,
        });
      }
      // Применяем override для greedy-matched пар.
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
        const oldStartUsd = item.p.startUsd;
        const newStartUsd = cb.netCostBasisUsd;
        if (oldStartUsd > 0 && Math.abs(newStartUsd - oldStartUsd) / oldStartUsd < DISTANCE_TOLERANCE) {
          // L4: pct-diff < DISTANCE_TOLERANCE (1%) — не override startUsd,
          // но прокидываем matchedV3TokenId. ВАЖНО: для orphan'ов
          // (coverageIncomplete=true) всё равно backfill'им openedAt /
          // openHash / ageDays / openedInTokens — это независимо от
          // startUsd override'а и нужно даже когда startUsd accurate.
          let next: OpenPosition = {
            ...item.p,
            matchedV3TokenId: nft.tokenId.toString(),
          };
          next = backfillOrphanMeta(next, cb, nft);
          result[item.idx] = next;
          continue;
        }
        let next: OpenPosition = { ...item.p };
        next.startUsd = newStartUsd;
        next.matchedV3TokenId = nft.tokenId.toString();
        if (oldStartUsd > 0) {
          next.supplyTokens = item.p.supplyTokens.map((t) => ({
            ...t,
            startUsd: (t.startUsd / oldStartUsd) * newStartUsd,
          }));
        }
        next = backfillOrphanMeta(next, cb, nft);
        // H6: do NOT subtract currentDebtUsd. PnL is the change in
        // collateral value only; debt is a separate liability tracked
        // via `currentDebtUsd`. Subtracting it here double-counts the
        // loan against the user (the cash they received is sitting in
        // their wallet, not lost to PnL).
        next.netPnlUsd = next.currentUsd - next.startUsd;
        next.netPnlPct =
          next.startUsd > 0 ? (next.netPnlUsd / next.startUsd) * 100 : 0;
        result[item.idx] = next;
        overriddenCount++;
        warnings.push(
          `[V3 override per-NFT amount-match] ${item.p.id} (NFT #${nft.tokenId}): ` +
            `$${oldStartUsd.toFixed(2)} → $${newStartUsd.toFixed(2)}`,
        );
      }
      // Заменяем itemsWithoutMatch только теми, которые ОСТАЛИСЬ unmatched.
      itemsWithoutMatch.length = 0;
      itemsWithoutMatch.push(...stillUnmatched);
    }

    if (itemsWithoutMatch.length === 0) continue;

    // ──────────────────────────────────────────────────────────────────
    // PHASE 2: pro-rata fallback для unmatched positions
    // (если openHash и amount-match не сработали — последняя резервная
    // стратегия). Используем cost basis NFT'ов, которые НЕ были привязаны
    // в Phase 1/1.5.
    // ──────────────────────────────────────────────────────────────────
    const greedyMatchedNftIds = new Set<string>();
    // Здесь мы могли бы аккуратно отслеживать NFT'ы, заматченные в Phase 1.5,
    // но достаточно tracking по mintTxHash из всех matched warnings — упрощаем
    // повторным проходом: смотрим на result-overrides для items в этой группе.
    // Лучше проще: matched положили netCostBasis в startUsd точечно, считаем
    // только не-matched.
    const matchedHashes = new Set(
      items
        .filter((x) => !itemsWithoutMatch.includes(x))
        .map((x) => (x.p.openHash ?? "").toLowerCase()),
    );
    // Также добавляем NFT'ы, которых уже unикально привязали по amount-match
    // (через result[idx] — у них startUsd уже = одному из netCostBasisUsd).
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      if (itemsWithoutMatch.includes(it)) continue;
      const overriddenStart = result[it.idx]?.startUsd;
      if (overriddenStart == null) continue;
      // Найти NFT с таким netCostBasisUsd (точное совпадение после override).
      for (const nft of nfts) {
        const cb = v3CostBasis.get(nft.tokenId.toString());
        // Absolute (not pct) — comparing two USD amounts directly,
// 1 cent difference = identity match for FX rounding noise.
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
      // Skip NFT'ы, заматченные через openHash (Phase 1).
      if (cb.mintTxHash && matchedHashes.has(cb.mintTxHash.toLowerCase())) continue;
      // Skip NFT'ы, заматченные через amount-match (Phase 1.5).
      if (greedyMatchedNftIds.has(nft.tokenId.toString())) continue;
      unmatchedAuthTotal += cb.netCostBasisUsd;
      hasAuthData = true;
    }
    if (!hasAuthData || unmatchedAuthTotal <= 0) continue;

    const currentTotalStart = itemsWithoutMatch.reduce((s, x) => s + x.p.startUsd, 0);
    if (currentTotalStart <= 0) continue;

    // H5 (2026-05-14): previous logic compared GROUP totals — if the
    // sum of all unmatched positions' old startUsd was within 1% of
    // the authoritative sum, the entire group was skipped. This hid
    // compensating per-NFT errors (e.g. +$2k on one position offset
    // by −$2k on another → sum looks correct, but each individual
    // PnL is wrong by tens of percent). Now we ALWAYS apply pro-rata
    // distribution at the per-NFT level and only skip writes that
    // are individually within tolerance.
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
      // Per-NFT skip: don't churn if our pro-rata estimate lands
      // within 1% of the existing startUsd. The override has FX cost
      // (recomputes supplyTokens proportionally, breaks downstream
      // memoization), so it's worth dodging when not needed.
      if (
        oldStartUsd > 0 &&
        Math.abs(newStartUsd - oldStartUsd) / oldStartUsd < DISTANCE_TOLERANCE
      ) {
        continue;
      }
      const next: OpenPosition = { ...x.p };
      next.startUsd = newStartUsd;
      if (oldStartUsd > 0) {
        next.supplyTokens = x.p.supplyTokens.map((t) => ({
          ...t,
          startUsd: (t.startUsd / oldStartUsd) * newStartUsd,
        }));
      }
      // H6: collateral-side PnL only.
      next.netPnlUsd = next.currentUsd - next.startUsd;
      next.netPnlPct =
        next.startUsd > 0 ? (next.netPnlUsd / next.startUsd) * 100 : 0;
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
