/**
 * Настройки колонок таблицы открытых позиций — показывать/скрыть + порядок.
 * Хранятся в localStorage. Каждый ID колонки — стабильная строка
 * (см. COLUMN_DEFS в OpenPositionsPage).
 */

import { useLocalStorage } from "@/lib/useLocalStorage";

export interface ColumnPrefs {
  /** Колонки которые видимы. Если ID нет в map'е — считаем видимым (default-показ). */
  hidden: Record<string, boolean>;
  /** Порядок ID колонок. Колонки которых нет в массиве рендерятся в исходном порядке после. */
  order: string[];
}

const KEY = "capflow.openPositions.columnPrefs";

const DEFAULT: ColumnPrefs = { hidden: {}, order: [] };

export function useColumnPrefs() {
  return useLocalStorage<ColumnPrefs>(KEY, DEFAULT);
}

/**
 * Применить пользовательский порядок и скрытие к канонному списку колонок.
 * - Колонки с `required: true` всегда видимы (нельзя спрятать).
 * - Сортировка: сначала те что в prefs.order (в указанном порядке), потом
 *   остальные в исходном порядке.
 */
export function applyColumnPrefs<T extends { id: string; required?: boolean }>(
  defs: readonly T[],
  prefs: ColumnPrefs,
): T[] {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const seen = new Set<string>();
  const ordered: T[] = [];
  // 1) Сначала те что есть в prefs.order — в порядке prefs.
  for (const id of prefs.order) {
    const d = byId.get(id);
    if (d && !seen.has(id)) {
      ordered.push(d);
      seen.add(id);
    }
  }
  // 2) Затем остальные — в исходном порядке defs.
  for (const d of defs) {
    if (!seen.has(d.id)) {
      ordered.push(d);
      seen.add(d.id);
    }
  }
  // 3) Применяем фильтр видимости (required всегда видимый).
  return ordered.filter((d) => d.required || !prefs.hidden[d.id]);
}
