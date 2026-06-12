/**
 * Post-process: 2+ OpenPositions с одинаковым `matchedV3TokenId` → reassign
 * extras на sibling NFT'ы в том же пуле (когда они есть в Krystal Map).
 *
 * Перенесено ДОСЛОВНО из apps/web/src/lib/portfolio/v3_dedupe_matched.ts
 * (порт V3-операций в серверный движок, 2026-06-12) — web теперь re-export
 * отсюда, чтобы не плодить параллельные реализации (anti-recurrence #3).
 *
 * Проблема (MMaksimuk POS-019/020):
 *   Юзер открыл 2 nearly-identical V3 NFT в одном пуле (USDT/SLVon ETH).
 *   Phase 1.5 amount-match в v3_cost_basis_override.ts может ткнуть обе
 *   позиции в один NFT. Вместо распутывания всех путей внутри override —
 *   POST-PROCESS dedup: находим дубликаты matchedV3TokenId, реассайним
 *   extras на свободные sibling NFT'ы (same pool, same wallet, same chain).
 *
 *   Гарантии:
 *     - НЕ создаём новые matches (только перераспределяем существующие)
 *     - НЕ трогаем positions без matchedV3TokenId
 *     - НЕ забираем NFT который уже использован другой position
 *     - Если sibling'ов нет — оставляем как есть (silent no-op)
 */

import type { KrystalV3Summary } from "./krystal/adapter.js";
import type { OpenPosition } from "./open_positions.js";

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
