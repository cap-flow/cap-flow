/**
 * Post-process: 2+ OpenPositions с одинаковым `matchedV3TokenId` → reassign
 * extras на sibling NFT'ы в том же пуле (когда они есть в Krystal Map).
 *
 * Проблема (MMaksimuk POS-019/020):
 *   Юзер открыл 2 nearly-identical V3 NFT в одном пуле (USDT/SLVon ETH).
 *   Phase 1.5 amount-match в v3_cost_basis_override.ts greedy-assigns
 *   1-to-1 ВНУТРИ группы — но эта группа определяется через
 *   `v3PositionMap.get(key)` где key = `(walletId, chain, deploymentId, sortedSymbols)`.
 *   Если 2 OpenPosition имеют идентичные supplyTokens и оба попадают в
 *   itemsWithoutMatch (одинаковый openHash → ambiguous), greedy match
 *   находит первую пару (item-0, nft-0) с минимальной distance, потом
 *   (item-1, nft-1). Должно работать корректно.
 *
 *   Но в проде наблюдается: оба matchedV3TokenId = "1220776" (один и тот
 *   же NFT). Где-то логика расходится — возможно одна из позиций попала
 *   в Phase 1 hash-match, другая в Phase 1.5 amount-match, и обе случайно
 *   ткнулись в #1220776.
 *
 *   Вместо понимания всех путей внутри v3_cost_basis_override — добавляем
 *   POST-PROCESS dedup: после всех override'ов проходимся по результату,
 *   находим дубликаты matchedV3TokenId, реассайним extras на свободные
 *   sibling NFT'ы (same pool, same wallet, same chain).
 *
 *   Гарантии:
 *     - НЕ создаём новые matches (только перераспределяем существующие)
 *     - НЕ трогаем positions без matchedV3TokenId
 *     - НЕ забираем NFT который уже использован другой position
 *     - Если sibling'ов нет — оставляем как есть (silent no-op)
 *
 *   Применимо для любого юзера с 2+ NFT в одном пуле.
 */

import type { KrystalV3Summary } from "../krystal/adapter";
import type { OpenPosition } from "./open_positions";

export interface DedupResult {
  positions: OpenPosition[];
  reassignedCount: number;
  warnings: string[];
}

/**
 * Pure function — возвращает новый массив с реассайнменом дублирующихся
 * matchedV3TokenId. Если Krystal Map не содержит sibling NFT'ов в том же
 * пуле — оставляет дубль (degradation: visual bug остаётся, но никаких
 * worse не делает).
 */
export function dedupeMatchedV3TokenIds(
  positions: readonly OpenPosition[],
  krystalByTokenId: ReadonlyMap<string, KrystalV3Summary>,
): DedupResult {
  if (krystalByTokenId.size === 0) {
    return { positions: positions.slice(), reassignedCount: 0, warnings: [] };
  }

  // 1. Group position indices by matchedV3TokenId
  const indicesByTokenId = new Map<string, number[]>();
  positions.forEach((p, i) => {
    if (!p.matchedV3TokenId) return;
    const arr = indicesByTokenId.get(p.matchedV3TokenId) ?? [];
    arr.push(i);
    indicesByTokenId.set(p.matchedV3TokenId, arr);
  });

  // 2. Set всех используемых tokenId — sibling reassignment не может туда
  // ткнуться (иначе создадим новый дубль).
  const usedTokenIds = new Set(indicesByTokenId.keys());

  // 3. Для каждой дублирующейся группы — найти sibling NFT'ы
  const result: OpenPosition[] = positions.slice();
  let reassignedCount = 0;
  const warnings: string[] = [];

  for (const [dupTokenId, indices] of indicesByTokenId) {
    if (indices.length < 2) continue;

    const anchor = krystalByTokenId.get(dupTokenId);
    if (!anchor) continue;

    // Sibling = NFT в Krystal Map с тем же pool/owner/chain, не использованный.
    const siblings: KrystalV3Summary[] = [];
    for (const k of krystalByTokenId.values()) {
      if (k.tokenId === dupTokenId) continue;
      if (usedTokenIds.has(k.tokenId)) continue;
      if (k.poolAddress.toLowerCase() !== anchor.poolAddress.toLowerCase()) continue;
      if (k.ownerAddress.toLowerCase() !== anchor.ownerAddress.toLowerCase()) continue;
      if (k.chainCode.toLowerCase() !== anchor.chainCode.toLowerCase()) continue;
      if (k.status === "CLOSED") continue;
      siblings.push(k);
    }
    if (siblings.length === 0) continue;

    // 4. Оставляем первую позицию с original tokenId, реассайним extras.
    // Sort indices ASC — порядок появления в массиве (стабильно).
    const sortedIndices = [...indices].sort((a, b) => a - b);
    for (let i = 1; i < sortedIndices.length && i - 1 < siblings.length; i++) {
      const newTokenId = siblings[i - 1]!.tokenId;
      const posIdx = sortedIndices[i]!;
      const pos = result[posIdx]!;
      result[posIdx] = { ...pos, matchedV3TokenId: newTokenId };
      usedTokenIds.add(newTokenId);
      reassignedCount++;
      warnings.push(
        `[V3 dedup] ${pos.id}: matchedV3TokenId ${dupTokenId} → ${newTokenId} ` +
          `(sibling in same pool ${anchor.poolAddress.slice(0, 10)}…)`,
      );
    }
  }

  return { positions: result, reassignedCount, warnings };
}
