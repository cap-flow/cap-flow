/**
 * Popover настройки колонок таблицы — показать/скрыть через чекбокс +
 * drag-and-drop переупорядочивание (нативный HTML5 DnD, без библиотек).
 */

import { useRef, useState } from "react";
import { GripVertical, Settings } from "lucide-react";

import { cn } from "@/lib/utils";

interface ColumnDef {
  id: string;
  label: string;
  required?: boolean;
}

interface ColumnSettingsProps {
  columns: readonly ColumnDef[];
  hidden: Record<string, boolean>;
  order: string[];
  onChange: (next: { hidden: Record<string, boolean>; order: string[] }) => void;
}

export function ColumnSettings({ columns, hidden, order, onChange }: ColumnSettingsProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Закрытие по клику вне.
  if (open) {
    queueMicrotask(() => {
      const onDown = (e: MouseEvent) => {
        if (
          panelRef.current?.contains(e.target as Node) ||
          triggerRef.current?.contains(e.target as Node)
        )
          return;
        setOpen(false);
        document.removeEventListener("mousedown", onDown);
      };
      document.addEventListener("mousedown", onDown, { once: false });
    });
  }

  // Эффективный порядок: сначала из order, потом остальные в исходном.
  const ordered = (() => {
    const byId = new Map(columns.map((c) => [c.id, c]));
    const seen = new Set<string>();
    const arr: ColumnDef[] = [];
    for (const id of order) {
      const c = byId.get(id);
      if (c && !seen.has(id)) {
        arr.push(c);
        seen.add(id);
      }
    }
    for (const c of columns) {
      if (!seen.has(c.id)) {
        arr.push(c);
        seen.add(c.id);
      }
    }
    return arr;
  })();

  const toggleHidden = (id: string, isHidden: boolean) => {
    const next = { ...hidden };
    if (isHidden) next[id] = true;
    else delete next[id];
    onChange({ hidden: next, order });
  };

  // DnD state
  const dragId = useRef<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const handleDrop = (targetId: string) => {
    const sourceId = dragId.current;
    dragId.current = null;
    setDragOverId(null);
    if (!sourceId || sourceId === targetId) return;
    const ids = ordered.map((c) => c.id);
    const fromIdx = ids.indexOf(sourceId);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    const next = [...ids];
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, sourceId);
    onChange({ hidden, order: next });
  };

  const reset = () => onChange({ hidden: {}, order: [] });

  // Массовые действия: показать все / скрыть все (кроме обязательных).
  // Порядок сохраняется — меняем только видимость. Дальше юзер точечно
  // отмечает нужные колонки чекбоксами.
  const selectAll = () => onChange({ hidden: {}, order });
  const deselectAll = () => {
    const next: Record<string, boolean> = {};
    for (const c of columns) if (!c.required) next[c.id] = true;
    onChange({ hidden: next, order });
  };

  const visibleCount = ordered.filter((c) => !hidden[c.id]).length;
  const allVisible = visibleCount === columns.length;
  const optionalCount = columns.filter((c) => !c.required).length;
  const allHidden = visibleCount === columns.length - optionalCount;

  return (
    <div className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Настройки колонок"
        title="Настройки колонок"
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary px-3 py-2 text-sm transition-colors hover:border-brand-cyan/40 hover:text-foreground",
          open ? "text-foreground border-brand-cyan/40" : "text-muted-foreground",
        )}
      >
        <Settings className="h-4 w-4" />
        <span className="font-medium">Настройки</span>
        <span className="text-[10px] opacity-70">
          {visibleCount}/{columns.length}
        </span>
      </button>

      {open && (
        <div
          ref={panelRef}
          className="absolute right-0 top-full z-50 mt-2 w-80 rounded-lg border border-border bg-popover p-3 shadow-xl"
        >
          <div className="mb-2">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-foreground">
                  Колонки таблицы
                </div>
                <div className="text-[10px] text-muted-foreground">
                  Скрытие чекбоксом · перетягивание ⋮⋮
                </div>
              </div>
              <button
                type="button"
                onClick={reset}
                className="rounded px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                Сбросить
              </button>
            </div>
            <div className="mt-2 flex items-center gap-1.5">
              <button
                type="button"
                onClick={selectAll}
                disabled={allVisible}
                className={cn(
                  "flex-1 rounded border border-border px-2 py-1 text-[11px] font-medium transition-colors",
                  allVisible
                    ? "cursor-not-allowed text-muted-foreground/40"
                    : "text-muted-foreground hover:border-brand-cyan/40 hover:text-foreground",
                )}
              >
                Выбрать все
              </button>
              <button
                type="button"
                onClick={deselectAll}
                disabled={allHidden}
                className={cn(
                  "flex-1 rounded border border-border px-2 py-1 text-[11px] font-medium transition-colors",
                  allHidden
                    ? "cursor-not-allowed text-muted-foreground/40"
                    : "text-muted-foreground hover:border-brand-cyan/40 hover:text-foreground",
                )}
              >
                Снять все
              </button>
            </div>
          </div>
          <div className="max-h-80 space-y-0.5 overflow-y-auto pr-1">
            {ordered.map((col) => {
              const isHidden = !!hidden[col.id];
              const isDragOver = dragOverId === col.id;
              return (
                <div
                  key={col.id}
                  draggable
                  onDragStart={() => {
                    dragId.current = col.id;
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (dragOverId !== col.id) setDragOverId(col.id);
                  }}
                  onDragLeave={() => {
                    if (dragOverId === col.id) setDragOverId(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    handleDrop(col.id);
                  }}
                  onDragEnd={() => {
                    dragId.current = null;
                    setDragOverId(null);
                  }}
                  className={cn(
                    "flex items-center gap-2 rounded px-2 py-1.5 transition-colors",
                    isDragOver && "bg-brand-cyan/10 ring-1 ring-brand-cyan/40",
                    !isDragOver && "hover:bg-accent",
                  )}
                >
                  <GripVertical className="h-4 w-4 cursor-grab text-muted-foreground/60 hover:text-foreground active:cursor-grabbing" />
                  <input
                    type="checkbox"
                    checked={!isHidden}
                    disabled={col.required}
                    onChange={(e) => toggleHidden(col.id, !e.target.checked)}
                    className="h-3.5 w-3.5 cursor-pointer accent-brand-cyan"
                    id={`col-${col.id}`}
                  />
                  <label
                    htmlFor={`col-${col.id}`}
                    className={cn(
                      "flex-1 cursor-pointer text-xs",
                      isHidden && "text-muted-foreground line-through",
                      col.required && "cursor-not-allowed",
                    )}
                  >
                    {col.label}
                    {col.required && (
                      <span className="ml-1 text-[9px] uppercase text-muted-foreground">
                        обязат.
                      </span>
                    )}
                  </label>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
