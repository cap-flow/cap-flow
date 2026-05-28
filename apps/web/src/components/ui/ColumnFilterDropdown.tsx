/**
 * Google-Sheets-style дропдаун на заголовке столбца таблицы открытых позиций:
 *   - сортировка ↑/↓ (подпись зависит от типа столбца);
 *   - текстовые столбцы — чекбокс-список ВСЕХ значений + поиск;
 *   - числовые/date столбцы — диапазон min/max (для дат — от/до).
 *
 * Панель рендерится через portal (position: fixed) — иначе её обрезает
 * `overflow-x-auto` контейнера таблицы.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDownAZ, ArrowUpAZ, Check, ListFilter, X } from "lucide-react";

import { cn } from "@/lib/utils";
import type {
  ColumnKind,
  RangeFilter,
  SortDir,
} from "@/lib/portfolio/column_sort_filter";

interface Props {
  kind: ColumnKind;
  /** Текущее направление сортировки ЭТОГО столбца (null — не сортируется им). */
  sortDir: SortDir | null;
  onSort: (dir: SortDir) => void;
  onClearSort: () => void;
  // ── Текстовый режим (kind === "text") ──
  computeValues: () => string[];
  selected: string[] | null; // null = все (фильтр не активен)
  onChangeSelected: (next: string[] | null) => void;
  // ── Range-режим (kind === "number" | "date") ──
  range: RangeFilter | null;
  onChangeRange: (next: RangeFilter | null) => void;
}

const SORT_LABELS: Record<ColumnKind, { asc: string; desc: string }> = {
  number: { desc: "По убыванию (9→0)", asc: "По возрастанию (0→9)" },
  date: { desc: "Сначала новые", asc: "Сначала старые" },
  text: { desc: "Я → А", asc: "А → Я" },
};

/** unix sec → "YYYY-MM-DD" (UTC, для date-инпута). */
function secToDateInput(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return "";
  return new Date(sec * 1000).toISOString().slice(0, 10);
}
/** "YYYY-MM-DD" → unix sec. `end=true` → конец дня. */
function dateInputToSec(v: string, end: boolean): number | null {
  if (!v) return null;
  const ms = Date.parse(`${v}T${end ? "23:59:59" : "00:00:00"}Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export function ColumnFilterDropdown(props: Props): JSX.Element {
  const {
    kind,
    sortDir,
    onSort,
    onClearSort,
    computeValues,
    selected,
    onChangeSelected,
    range,
    onChangeRange,
  } = props;

  const isRange = kind === "number" || kind === "date";

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [values, setValues] = useState<string[]>([]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const filterActive = isRange
    ? !!range && (range.min != null || range.max != null)
    : selected != null && selected.length > 0;

  const openPanel = () => {
    if (!isRange) setValues(computeValues());
    setQuery("");
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      const W = 256;
      const left = Math.min(r.left, window.innerWidth - W - 8);
      setPos({ top: r.bottom + 4, left: Math.max(8, left) });
    };
    place();
    const onDown = (e: MouseEvent) => {
      if (
        panelRef.current?.contains(e.target as Node) ||
        triggerRef.current?.contains(e.target as Node)
      )
        return;
      setOpen(false);
    };
    // Скролл ВНУТРИ панели (список значений) не должен её закрывать —
    // иначе нельзя проскроллить длинный список. Внешний скролл
    // (страница/таблица) — перепозиционируем панель к триггеру.
    const onScroll = (e: Event) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      place();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  // ── text-режим helpers ──
  const checked = selected === null ? new Set(values) : new Set(selected);
  const allChecked = selected === null;
  const toggle = (v: string) => {
    const next = new Set(checked);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    // Весь набор ИЛИ пусто → «нет фильтра» (null): таблица не опустошается,
    // снятие последней галочки возвращает «показать все».
    if (next.size === values.length || next.size === 0) onChangeSelected(null);
    else onChangeSelected([...next]);
  };
  const filtered = query
    ? values.filter((v) => v.toLowerCase().includes(query.toLowerCase()))
    : values;

  // ── range-режим helpers ──
  const setRange = (min: number | null, max: number | null) => {
    if (min == null && max == null) onChangeRange(null);
    else onChangeRange({ min, max });
  };

  const labels = SORT_LABELS[kind];

  return (
    <span className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          open ? setOpen(false) : openPanel();
        }}
        title="Сортировка и фильтр"
        className={cn(
          "inline-flex h-4 w-4 items-center justify-center rounded transition-colors",
          sortDir || filterActive
            ? "text-brand-cyan"
            : "text-muted-foreground/50 hover:text-foreground",
        )}
      >
        {sortDir === "asc" ? (
          <ArrowUpAZ className="h-3.5 w-3.5" />
        ) : sortDir === "desc" ? (
          <ArrowDownAZ className="h-3.5 w-3.5" />
        ) : (
          <ListFilter className="h-3.5 w-3.5" />
        )}
        {filterActive && (
          <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-brand-cyan" />
        )}
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            style={{ position: "fixed", top: pos.top, left: pos.left, width: 256 }}
            className="z-[100] rounded-lg border border-border bg-popover p-2 text-left shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Сортировка */}
            <div className="flex flex-col gap-0.5">
              <button
                type="button"
                onClick={() => { onSort("desc"); setOpen(false); }}
                className={cn(
                  "flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-secondary",
                  sortDir === "desc" && "text-brand-cyan",
                )}
              >
                <ArrowDownAZ className="h-3.5 w-3.5" /> {labels.desc}
              </button>
              <button
                type="button"
                onClick={() => { onSort("asc"); setOpen(false); }}
                className={cn(
                  "flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-secondary",
                  sortDir === "asc" && "text-brand-cyan",
                )}
              >
                <ArrowUpAZ className="h-3.5 w-3.5" /> {labels.asc}
              </button>
              {sortDir && (
                <button
                  type="button"
                  onClick={() => { onClearSort(); setOpen(false); }}
                  className="flex items-center gap-2 rounded px-2 py-1.5 text-xs text-muted-foreground hover:bg-secondary"
                >
                  <X className="h-3.5 w-3.5" /> Сбросить сортировку
                </button>
              )}
            </div>

            <div className="my-1.5 border-t border-border" />

            {isRange ? (
              /* ── Диапазон min/max (для дат — от/до) ── */
              <div className="flex flex-col gap-1.5">
                <div className="px-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                  {kind === "date" ? "Период (от / до)" : "Диапазон (от / до)"}
                </div>
                {kind === "date" ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      type="date"
                      value={secToDateInput(range?.min ?? null)}
                      onChange={(e) =>
                        setRange(dateInputToSec(e.target.value, false), range?.max ?? null)
                      }
                      className="w-full rounded border border-border bg-background px-1.5 py-1 text-xs outline-none focus:border-brand-cyan/50"
                    />
                    <span className="text-muted-foreground">–</span>
                    <input
                      type="date"
                      value={secToDateInput(range?.max ?? null)}
                      onChange={(e) =>
                        setRange(range?.min ?? null, dateInputToSec(e.target.value, true))
                      }
                      className="w-full rounded border border-border bg-background px-1.5 py-1 text-xs outline-none focus:border-brand-cyan/50"
                    />
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      placeholder="мин"
                      value={range?.min ?? ""}
                      onChange={(e) =>
                        setRange(
                          e.target.value === "" ? null : Number(e.target.value),
                          range?.max ?? null,
                        )
                      }
                      className="w-full rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:border-brand-cyan/50"
                    />
                    <span className="text-muted-foreground">–</span>
                    <input
                      type="number"
                      placeholder="макс"
                      value={range?.max ?? ""}
                      onChange={(e) =>
                        setRange(
                          range?.min ?? null,
                          e.target.value === "" ? null : Number(e.target.value),
                        )
                      }
                      className="w-full rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:border-brand-cyan/50"
                    />
                  </div>
                )}
                {filterActive && (
                  <button
                    type="button"
                    onClick={() => onChangeRange(null)}
                    className="flex items-center gap-1.5 self-start rounded px-1 py-1 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" /> Сбросить фильтр
                  </button>
                )}
              </div>
            ) : (
              /* ── Чекбокс-список значений ── */
              <>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Поиск значения…"
                  className="mb-1.5 w-full rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:border-brand-cyan/50"
                />
                <div className="mb-1 flex items-center justify-between px-1 text-[10px] text-muted-foreground">
                  <button type="button" className="hover:text-foreground" onClick={() => onChangeSelected(null)}>
                    Выбрать всё
                  </button>
                  {filterActive && (
                    <button type="button" className="hover:text-foreground" onClick={() => onChangeSelected(null)}>
                      Сбросить фильтр
                    </button>
                  )}
                </div>
                <div className="max-h-56 overflow-y-auto">
                  {filtered.length === 0 ? (
                    <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                      Нет значений
                    </div>
                  ) : (
                    filtered.map((v) => {
                      const on = allChecked || checked.has(v);
                      return (
                        <button
                          key={v}
                          type="button"
                          onClick={() => toggle(v)}
                          className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-secondary"
                        >
                          <span
                            className={cn(
                              "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border",
                              on
                                ? "border-brand-cyan bg-brand-cyan/20 text-brand-cyan"
                                : "border-border",
                            )}
                          >
                            {on && <Check className="h-2.5 w-2.5" />}
                          </span>
                          <span className="truncate">{v}</span>
                        </button>
                      );
                    })
                  )}
                </div>
              </>
            )}
          </div>,
          document.body,
        )}
    </span>
  );
}
