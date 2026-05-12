/**
 * Модалка для задания «состава» wrapper-токена (JLP, GLP, LST и т.п.).
 *
 * Пользователь добавляет underlying-токены и их доли. Сумма должна быть 100%.
 * Сохранение — в localStorage через `useAssetCompositions`.
 */

import { useMemo, useState } from "react";
import { Plus, X, Check } from "lucide-react";

import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  type AssetComposition,
  type AssetCompositionItem,
  normalizeCompositionKey,
  useAssetCompositions,
} from "@/lib/portfolio/asset_composition";
import { cn } from "@/lib/utils";

interface AssetCompositionDialogProps {
  /** Символ wrapper-токена (для которого задаётся состав). */
  symbol: string;
  /** Доступные символы для autocomplete (из портфеля). */
  knownSymbols?: string[];
  /**
   * Scope привязки. Если задан — состав сохраняется только для этой
   * позиции (`positionOverrideKey`). Если нет — глобально по символу.
   */
  scope?: string;
  /** Описание контекста — например, имя позиции или «Cap Wallet». */
  scopeLabel?: string;
  open: boolean;
  onClose: () => void;
}

export function AssetCompositionDialog({
  symbol,
  knownSymbols = [],
  scope,
  scopeLabel,
  open,
  onClose,
}: AssetCompositionDialogProps) {
  const [compositions, setComposition, clearComposition] = useAssetCompositions();
  const sym = normalizeCompositionKey(symbol);
  const scopedKey = scope ? `${scope}::${sym}` : sym;
  const initial = compositions[scopedKey];

  // State для формы — храним проценты (0..100) для удобства ввода.
  // Раньше при отсутствии scoped seed брался из global compositions —
  // это создавало путаницу: пользователь видел заполненную форму и думал
  // что состав уже задан для этой позиции, тогда как на самом деле это
  // был чужой global. Убрал — теперь форма пустая, если состава для
  // этой конкретной позиции нет.
  const [rows, setRows] = useState<{ symbol: string; pct: string }[]>(() => {
    if (initial && initial.length > 0) {
      return initial.map((c) => ({
        symbol: c.symbol,
        pct: (c.share * 100).toFixed(2),
      }));
    }
    return [
      { symbol: "", pct: "" },
      { symbol: "", pct: "" },
    ];
  });

  const totalPct = useMemo(
    () =>
      rows.reduce((s, r) => {
        const n = Number(r.pct.replace(",", "."));
        return s + (Number.isFinite(n) ? n : 0);
      }, 0),
    [rows],
  );
  const totalOk = Math.abs(totalPct - 100) < 0.01;
  const filledCount = rows.filter(
    (r) => r.symbol.trim() && Number(r.pct.replace(",", ".")) > 0,
  ).length;
  const canSave = totalOk && filledCount >= 1;

  function updateRow(i: number, patch: Partial<{ symbol: string; pct: string }>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((prev) => [...prev, { symbol: "", pct: "" }]);
  }
  function removeRow(i: number) {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
  }
  function distributeEqually() {
    const validRows = rows.filter((r) => r.symbol.trim());
    if (validRows.length === 0) return;
    const each = (100 / validRows.length).toFixed(2);
    setRows(rows.map((r) => (r.symbol.trim() ? { ...r, pct: each } : r)));
  }

  function save() {
    if (!canSave) return;
    const composition: AssetComposition = rows
      .filter((r) => r.symbol.trim() && Number(r.pct.replace(",", ".")) > 0)
      .map(
        (r): AssetCompositionItem => ({
          symbol: normalizeCompositionKey(r.symbol),
          share: Number(r.pct.replace(",", ".")) / 100,
        }),
      );
    setComposition(symbol, composition, scope);
    onClose();
  }

  function reset() {
    if (!initial) return;
    if (
      window.confirm(
        `Удалить состав для «${symbol}»${scopeLabel ? ` (${scopeLabel})` : ""}? Аналитика снова будет считать его как один токен.`,
      )
    ) {
      clearComposition(symbol, scope);
      onClose();
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={
        <span className="inline-flex items-center gap-2">
          Состав актива{" "}
          <span className="rounded-md bg-brand-cyan/15 px-2 py-0.5 font-mono text-sm text-brand-cyan">
            {symbol}
          </span>
          {scopeLabel && (
            <span className="rounded-md border border-border bg-secondary/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
              {scopeLabel}
            </span>
          )}
        </span>
      }
      description={
        scope
          ? `Состав сохраняется только для этой позиции${scopeLabel ? ` (${scopeLabel})` : ""}. Другие позиции с тем же токеном не затрагиваются.`
          : "Из чего состоит этот токен и в каких долях. Применяется ко всем вхождениям символа, у которых не задан собственный состав."
      }
      footer={
        <div className="flex items-center justify-between gap-2">
          {initial ? (
            <Button variant="ghost" onClick={reset} className="text-destructive">
              Удалить состав
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Отмена
            </Button>
            <Button onClick={save} disabled={!canSave}>
              <Check className="h-4 w-4" /> Сохранить
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <SymbolInput
              value={r.symbol}
              onChange={(v) => updateRow(i, { symbol: v })}
              suggestions={knownSymbols}
            />
            <div className="relative w-24 shrink-0">
              <Input
                inputMode="decimal"
                placeholder="0.00"
                value={r.pct}
                onChange={(e) => updateRow(i, { pct: e.target.value })}
                className="pr-6 text-right tabular-nums"
              />
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                %
              </span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => removeRow(i)}
              disabled={rows.length <= 1}
              className="shrink-0"
              title="Удалить строку"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ))}

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={addRow}>
            <Plus className="h-3.5 w-3.5" /> Добавить токен
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={distributeEqually}
            className="text-muted-foreground"
          >
            Распределить поровну
          </Button>
        </div>

        <div
          className={cn(
            "flex items-center justify-between rounded-md border px-3 py-2 text-sm",
            totalOk
              ? "border-success/40 bg-success/10 text-success"
              : "border-warning/40 bg-warning/10 text-warning",
          )}
        >
          <span className="font-medium uppercase tracking-wider text-[11px]">
            Сумма
          </span>
          <span className="font-bold tabular-nums">
            {totalPct.toFixed(2)}%
            {totalOk ? " ✓" : " — должно быть 100%"}
          </span>
        </div>
      </div>
    </Dialog>
  );
}

function SymbolInput({
  value,
  onChange,
  suggestions,
}: {
  value: string;
  onChange: (v: string) => void;
  suggestions: string[];
}) {
  const listId = `comp-symbols-${suggestions.length}`;
  return (
    <>
      <Input
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        placeholder="SOL / ETH / USDC"
        className="flex-1 font-mono uppercase"
        autoComplete="off"
      />
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </>
  );
}
