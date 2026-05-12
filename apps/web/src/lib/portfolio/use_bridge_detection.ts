/**
 * Hook + helper для авто-классификации `transfer_out/transfer_in` пар как
 * `bridge_out/bridge_in` между подключенными кошельками пользователя.
 *
 * Алгоритм (см. `internal_transfers.ts`):
 *  1. Берём все ops всех загруженных кошельков
 *  2. Ищем пары: out из одного кошелька + in в другой кошелёк
 *  3. Условия пары: одно «семейство» токена (USDT ↔ USD₮0), близкие суммы
 *     (±5% волатильные, ±10% стейблы — для покрытия комиссии моста), окно
 *     времени ±60 минут
 *  4. Найденные ops переклассифицируем: `transfer_out` → `bridge_out`,
 *     `transfer_in` → `bridge_in`
 *
 * Это даёт автоматическую разметку межкошельковых переводов как Bridge —
 * не нужно вручную проставлять.
 */

import { useMemo } from "react";

import type { Loaded } from "@/components/data/LoadedWalletsProvider";
import { findInternalTransferPairs } from "./internal_transfers";

/** Возвращает loadedList с переклассифицированными bridge_out/bridge_in. */
export function applyBridgeDetection(loaded: Loaded[]): Loaded[] {
  const items = [];
  for (const l of loaded) {
    for (const op of l.ops) items.push({ op, walletId: l.wallet.id });
  }
  const { matchedHashes } = findInternalTransferPairs(items);
  if (matchedHashes.size === 0) return loaded;
  return loaded.map((l) => ({
    ...l,
    ops: l.ops.map((op) => {
      if (!matchedHashes.has(op.hash)) return op;
      // Re-tag: transfer_in → bridge_in, transfer_out → bridge_out.
      if (op.type === "transfer_in") return { ...op, type: "bridge_in" as const };
      if (op.type === "transfer_out") return { ...op, type: "bridge_out" as const };
      return op;
    }),
  }));
}

/** Хук-обёртка с memoization. */
export function useLoadedListWithBridges(loaded: Loaded[]): Loaded[] {
  return useMemo(() => applyBridgeDetection(loaded), [loaded]);
}
