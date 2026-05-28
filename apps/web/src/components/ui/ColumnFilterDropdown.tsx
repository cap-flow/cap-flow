/**
 * Google-Sheets-style дропдаун на заголовке столбца таблицы открытых позиций:
 *   - сортировка ↑/↓ (подпись зависит от типа столбца);
 *   - чекбокс-список ВСЕХ значений столбца + поиск + «выбрать всё / очистить».
 *
 * Панель рендерится через portal (position: fixed) — иначе её обрезает
 * `overflow-x-auto` контейнера таблицы.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDownAZ, ArrowUpAZ, Check, ListFilter, X } from "lucide-react";

import { cn } from "@/lib/utils";
import type { ColumnKind, SortDir } from "@/lib/portfolio/column_sort_filter";

interface Props {
  kind: ColumnKind;
  /** Текущее направление сортировки ЭТОГО столбца (null — не сортируется им). */
  sortDir: SortDir | null;
  /** Активен ли value-фильтр столбца. */
  filterActive: boolean;
  /** Достать уникальные значения столбца (вызывается при открытии). */
  computeValues: () => string[];
  /** Выбранные значения; null = выбраны все (фильтр не активен). */
  selected: string[] | null;
  onSort: (dir: SortDir) => void;
  onClearSort: () => void;
  onChangeSelected: (next: string[] | null) => void;
}

const SORT_LABELS: Record<ColumnKind, { asc: string; desc: string }> = {
  number: { desc: "По убыванию (9→0)", asc: "По возрастанию (0→9)" },
  date: { desc: "Сначала новые", asc: "Сначала старые" },
  text: { desc: "Я → А", asc: "А → Я" },
};

export function ColumnFilterDropdown(props: Props): JSX.Element {
  const {
    kind,
    sortDir,
    filterActive,
    computeValues,
    selected,
    onSort,
    onClearSort,
    onChangeSelected,
  } = props;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [values, setValues] = useState<string[]>([]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const openPanel = () => {
    setValues(computeValues());
    setQuery("");
    setOpen(true);
  };

  // Позиционирование + close-on-outside/scroll/resize.
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
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const checked = selected === null ? new Set(values) : new Set(selected);
  const allChecked = selected === null;

  const toggle = (v: string) => {
    const next = new Set(checked);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    if (next.size === values.length) onChangeSelected(null);
    else onChangeSelected([...next]);
  };

  const filtered = query
    ? values.filter((v) => v.toLowerCase().includes(query.toLowerCase()))
    : values;

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

            {/* Поиск + select all/clear */}
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
              <button type="button" className="hover:text-foreground" onClick={() => onChangeSelected([])}>
                Очистить
              </button>
            </div>

            {/* Чекбокс-список значений */}
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
          </div>,
          document.body,
        )}
    </span>
  );
}
