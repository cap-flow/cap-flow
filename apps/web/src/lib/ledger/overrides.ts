/**
 * Ручные правки операций — поверх auto-генерации.
 *
 * Зачем: автоматическая классификация может ошибиться (например, swap
 * посчитала за transfer, или from/to неточны). Пользователь правит поля
 * руками — изменения сохраняются по `txHash` и применяются поверх
 * сгенерированного `ManualOp`. При следующей перезагрузке кэша
 * (incremental sync, rebuild классификатора) правки **переживают**, потому
 * что привязаны к стабильному tx-хэшу.
 */

import { useLocalStorage } from "@/lib/useLocalStorage";
import type { ManualOp } from "./types";

/** Patch: только те поля, которые пользователь изменил. */
export type OpOverridePatch = Partial<Omit<ManualOp, "id" | "source">>;

export interface OpOverride {
  patch: OpOverridePatch;
  updatedAt: number;
}

export type OverridesMap = Record<string, OpOverride>; // txHash → override

const STORAGE_KEY = "capflow.opOverrides";

export function useOpOverrides() {
  return useLocalStorage<OverridesMap>(STORAGE_KEY, {});
}

/** Применяет override к ManualOp (если он есть для этого txHash). */
export function applyOverride(
  op: ManualOp,
  txHash: string | null,
  overrides: OverridesMap,
): ManualOp & { hasOverride?: boolean } {
  if (!txHash) return op;
  const o = overrides[txHash];
  if (!o || !o.patch) return op;
  return { ...op, ...o.patch, hasOverride: true };
}
