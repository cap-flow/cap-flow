/**
 * Per-column сортировка + value-фильтр для таблицы открытых позиций
 * (Google-Sheets-style: на каждый столбец — сортировка ↑/↓ и чекбокс-список
 * всех значений в столбце).
 *
 * Чистый модуль (без React) — тестируемо. `getColumnCell` извлекает из
 * OpenPosition для конкретного столбца:
 *   - `sortKey`  — ключ сортировки (число для numeric/date, строка для text);
 *   - `kind`     — тип столбца (для подписи направления сортировки в UI);
 *   - `values`   — отображаемые значения, которые строка даёт в этот столбец
 *                  (1 для скалярных, N для мульти-столбцов: токены/составы).
 *
 * Multi-value столбцы (Открыто в / Внесено токенов / Состав позиции) дают
 * НЕСКОЛЬКО значений → в фильтре столбца показываются ВСЕ значения, а строка
 * проходит фильтр если хоть одно её значение выбрано.
 */

import {
  formatDateShort,
  formatNumber,
  formatUsd,
} from "@/i18n/format";
import type { Locale } from "@/i18n/I18nProvider";
import {
  type OpenPosition,
  type PositionKind,
  totalAssetsOf,
} from "./open_positions";

const KIND_LABEL: Record<PositionKind, string> = {
  lending: "Лендинг",
  lp: "LP",
  staking: "Стейкинг",
  perp: "Perp",
  other: "Другое",
};

export type ColumnKind = "number" | "date" | "text";
export type SortDir = "asc" | "desc";

export interface ColumnCell {
  /** number для numeric/date, string для text; null = значения нет. */
  sortKey: number | string | null;
  kind: ColumnKind;
  /** Отображаемые значения (для распознавания в value-фильтре). */
  values: string[];
}

export interface CellContext {
  /** Σ currentUsd базового набора — знаменатель для «Вес %». */
  sumCurrentUsd: number;
  locale: Locale;
}

/** Статическая карта типов столбцов (для подписи сортировки в UI). */
export const COLUMN_KIND: Record<string, ColumnKind> = {
  id: "text",
  openedAt: "date",
  ageDays: "number",
  wallet: "text",
  chain: "text",
  protocol: "text",
  kind: "text",
  capital: "text",
  tokenId: "text",
  openedInToken: "text",
  openedInAmount: "number",
  supplyTokens: "text",
  startUsd: "number",
  currentUsd: "number",
  pnl: "number",
  fee: "number",
  feeApr: "number",
  totalAssets: "number",
  totalPnl: "number",
  totalApr: "number",
  weight: "number",
};

function pct(n: number, frac = 1): string {
  return `${n >= 0 ? "" : ""}${n.toFixed(frac)}%`;
}

/** Извлечь sortKey/values для строки `p` в столбце `colId`. */
export function getColumnCell(
  p: OpenPosition,
  colId: string,
  ctx: CellContext,
): ColumnCell {
  const { locale, sumCurrentUsd } = ctx;
  const numCell = (sortKey: number | null, values: string[]): ColumnCell => ({
    sortKey,
    kind: COLUMN_KIND[colId] ?? "number",
    values,
  });
  const txtCell = (sortKey: string, values: string[]): ColumnCell => ({
    sortKey: sortKey || null,
    kind: "text",
    values: values.filter((v) => v.length > 0),
  });

  switch (colId) {
    case "id": {
      const n = Number(p.id.replace(/\D/g, ""));
      return { sortKey: Number.isFinite(n) ? n : null, kind: "text", values: [p.id] };
    }
    case "openedAt":
      return numCell(
        p.openedAt ?? null,
        [p.openedAt ? formatDateShort(p.openedAt) : "—"],
      );
    case "ageDays":
      return numCell(
        p.ageDays ?? null,
        [p.ageDays != null ? `${p.ageDays} дн.` : "—"],
      );
    case "wallet":
      return txtCell(p.walletName, [p.walletName]);
    case "chain":
      return txtCell(p.chain.toUpperCase(), [p.chain.toUpperCase()]);
    case "protocol":
      return txtCell(p.protocol.name, [p.protocol.name]);
    case "kind": {
      const label = p.itemName || KIND_LABEL[p.kind] || p.kind;
      return txtCell(label, [label]);
    }
    case "capital": {
      const credit = p.creditFundedUsd > 0;
      return { sortKey: credit ? 1 : 0, kind: "text", values: [credit ? "Кредит" : "Свои"] };
    }
    case "tokenId": {
      const v = p.matchedV3TokenId
        ? `#${p.matchedV3TokenId}`
        : p.v3
          ? "NFT"
          : p.lpTokenId
            ? `${p.lpTokenId.slice(0, 10)}…`
            : "—";
      return txtCell(v, [v]);
    }
    case "openedInToken": {
      const syms = p.openedInTokens.map((t) => t.symbol);
      return { sortKey: syms[0] ?? null, kind: "text", values: syms };
    }
    case "openedInAmount": {
      const total = p.openedInTokens.reduce((s, t) => s + t.amount, 0);
      return numCell(
        p.openedInTokens.length > 0 ? total : null,
        p.openedInTokens.map((t) => formatNumber(t.amount, locale, 6)),
      );
    }
    case "supplyTokens": {
      const syms = p.supplyTokens.map((t) => t.symbol);
      return { sortKey: syms[0] ?? null, kind: "text", values: syms };
    }
    case "startUsd":
      return numCell(p.startUsd, [formatUsd(p.startUsd, locale)]);
    case "currentUsd":
      return numCell(p.currentUsd, [formatUsd(p.currentUsd, locale)]);
    case "pnl": {
      const v = p.currentUsd - p.startUsd;
      return numCell(v, [formatUsd(v, locale)]);
    }
    case "fee": {
      const v = (p.feesUsd ?? 0) + p.feesClaimedUsd;
      return numCell(v, [formatUsd(v, locale)]);
    }
    case "feeApr":
      return numCell(
        p.feeAprLifetime ?? null,
        [p.feeAprLifetime != null ? pct(p.feeAprLifetime) : "—"],
      );
    case "totalAssets": {
      const v = totalAssetsOf(p);
      return numCell(v, [formatUsd(v, locale)]);
    }
    case "totalPnl": {
      const v = totalAssetsOf(p) - p.startUsd;
      return numCell(v, [formatUsd(v, locale)]);
    }
    case "totalApr": {
      const totalPnl = totalAssetsOf(p) - p.startUsd;
      const apr =
        p.ageDays != null && p.ageDays > 0 && p.startUsd > 0
          ? (totalPnl / p.startUsd) * (365 / p.ageDays) * 100
          : null;
      return numCell(apr, [apr != null ? pct(apr, 2) : "—"]);
    }
    case "weight": {
      const w = sumCurrentUsd > 0 ? (p.currentUsd / sumCurrentUsd) * 100 : null;
      return numCell(w, [w != null ? pct(w) : "—"]);
    }
    default:
      return { sortKey: null, kind: "text", values: [] };
  }
}

function isMissing(v: number | string | null): boolean {
  if (v == null) return true;
  if (typeof v === "number") return !Number.isFinite(v);
  return v === "";
}

/** Сравнить две ячейки. Пустые значения всегда в конце (в обе стороны). */
function compareCells(a: ColumnCell, b: ColumnCell, dir: SortDir): number {
  const am = isMissing(a.sortKey);
  const bm = isMissing(b.sortKey);
  if (am && bm) return 0;
  if (am) return 1;
  if (bm) return -1;
  let c: number;
  if (typeof a.sortKey === "number" && typeof b.sortKey === "number") {
    c = a.sortKey - b.sortKey;
  } else {
    c = String(a.sortKey).localeCompare(String(b.sortKey), undefined, {
      numeric: true,
      sensitivity: "base",
    });
  }
  return dir === "asc" ? c : -c;
}

export interface ColumnSortFilterState {
  sortCol: string | null;
  sortDir: SortDir;
  /**
   * colId → выбранные значения. Присутствие ключа = фильтр активен.
   * `[]` (ключ есть, пусто) → не проходит ни одна строка. Отсутствие ключа =
   * фильтр не активен (все проходят).
   */
  valueFilters: Record<string, string[]>;
}

/**
 * Применить value-фильтры (membership) и сортировку (порядок) к набору.
 * Сортировка стабильна (ties → исходный порядок).
 */
export function applyColumnSortFilter(
  positions: readonly OpenPosition[],
  state: ColumnSortFilterState,
  ctx: CellContext,
): OpenPosition[] {
  let out: OpenPosition[] = positions.slice();

  const activeCols = Object.keys(state.valueFilters);
  if (activeCols.length > 0) {
    const sets = new Map(
      activeCols.map((col) => [col, new Set(state.valueFilters[col])]),
    );
    out = out.filter((p) => {
      for (const [col, sel] of sets) {
        const { values } = getColumnCell(p, col, ctx);
        if (!values.some((v) => sel.has(v))) return false;
      }
      return true;
    });
  }

  if (state.sortCol) {
    const col = state.sortCol;
    out = out
      .map((p, i) => [p, i] as const)
      .sort((A, B) => {
        const c = compareCells(
          getColumnCell(A[0], col, ctx),
          getColumnCell(B[0], col, ctx),
          state.sortDir,
        );
        return c !== 0 ? c : A[1] - B[1];
      })
      .map(([p]) => p);
  }

  return out;
}

/** Все уникальные значения столбца (для чекбокс-списка фильтра), отсортированы. */
export function distinctColumnValues(
  positions: readonly OpenPosition[],
  colId: string,
  ctx: CellContext,
): string[] {
  const set = new Set<string>();
  for (const p of positions) {
    for (const v of getColumnCell(p, colId, ctx).values) set.add(v);
  }
  return Array.from(set).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
  );
}
