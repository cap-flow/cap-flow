/**
 * Массовая разметка `transfer_in` ops по фиату.
 *
 * Показывает **плоский список операций** (как в реестре) с чекбоксами для
 * выбора. Пользователь:
 *  1. Применяет фильтры (только стейблы / только извне / скрыть спам)
 *  2. Видит все неразмеченные операции построчно — дата, кошелёк, сеть,
 *     amount + token
 *  3. Чекбоксом выбирает нужные (или «выбрать все» — все видимые)
 *  4. Указывает ОБЩУЮ сумму потраченного фиата + валюту
 *  5. Жмёт «Применить» → курс = общая_сумма / Σ token_amount → каждой
 *     выбранной операции назначается аннотация `amount × курс`
 */

import { useEffect, useMemo, useState } from "react";
import { Banknote, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  annotationKey,
  COMMON_FIAT_CURRENCIES,
  fiatSymbol,
  formatFiat,
  useOpAnnotations,
  type FiatCurrency,
  type FiatPurchaseAnnotation,
} from "@/lib/portfolio/manual_annotations";
import { isStableSymbol, tokenFamily } from "@/lib/portfolio/protocols";
import { looksLikeSpam } from "@/lib/portfolio/spl_tokens";
import type { ClassifiedOp } from "@/lib/portfolio/types";
import type { SavedWallet } from "@/lib/wallets";
import { formatNumber } from "@/i18n/format";
import { useI18n } from "@/i18n/I18nProvider";
import { cn } from "@/lib/utils";

interface BulkFiatMarkerProps {
  loadedList: { wallet: SavedWallet; ops: ClassifiedOp[] }[];
}

export function BulkFiatMarker({ loadedList }: BulkFiatMarkerProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-400 transition-colors hover:bg-emerald-500/20 hover:border-emerald-500/60"
      >
        <Banknote className="h-4 w-4" />
        Разметить стейблы
      </button>
      {open && (
        <BulkMarkerDialog loadedList={loadedList} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

/** Одна неразмеченная операция в списке. */
interface UnmarkedOp {
  walletId: string;
  walletName: string;
  walletChain: string; // "evm" | "sol" | …
  chain: string; // "eth" | "arb" | "sol" | …
  hash: string;
  time: number;
  symbol: string;
  family: string; // нормализованный, для сортировки/группировки
  amount: number;
  isStable: boolean;
  isSpam: boolean;
}

function BulkMarkerDialog({
  loadedList,
  onClose,
}: {
  loadedList: { wallet: SavedWallet; ops: ClassifiedOp[] }[];
  onClose: () => void;
}) {
  const { locale } = useI18n();
  const [annotations, setAnnotations] = useOpAnnotations();

  const [hideSpam, setHideSpam] = useState(true);
  const [onlyExternal, setOnlyExternal] = useState(true);
  const [onlyStables, setOnlyStables] = useState(true);

  // Адреса всех наших кошельков (нижний регистр) — для определения «извне».
  const ownAddresses = useMemo(() => {
    const s = new Set<string>();
    for (const l of loadedList) s.add(l.wallet.address.toLowerCase());
    return s;
  }, [loadedList]);

  // Плоский список неразмеченных transfer_in ops, отфильтрованный.
  const unmarked = useMemo(() => {
    const list: UnmarkedOp[] = [];
    for (const l of loadedList) {
      for (const op of l.ops) {
        if (op.type !== "transfer_in") continue;
        const key = annotationKey({
          walletId: l.wallet.id,
          chain: op.chain,
          hash: op.hash,
        });
        if (annotations[key]?.fiatPurchase) continue; // уже размечен
        if (
          onlyExternal &&
          op.counterparty &&
          ownAddresses.has(op.counterparty.toLowerCase())
        ) {
          continue;
        }
        const inMv = op.movement.find(
          (mv) => mv.direction === "in" && mv.amount > 0,
        );
        if (!inMv) continue;
        const stable = isStableSymbol(inMv.symbol);
        const spam = looksLikeSpam(inMv.symbol, op.protocol?.name ?? undefined);
        if (hideSpam && spam) continue;
        if (onlyStables && !stable) continue;
        list.push({
          walletId: l.wallet.id,
          walletName: l.wallet.name,
          walletChain: l.wallet.chain,
          chain: op.chain,
          hash: op.hash,
          time: op.time,
          symbol: inMv.symbol,
          family: tokenFamily(inMv.symbol),
          amount: inMv.amount,
          isStable: stable,
          isSpam: spam,
        });
      }
    }
    // Сортируем: новые первыми.
    return list.sort((a, b) => b.time - a.time);
  }, [loadedList, annotations, hideSpam, onlyExternal, onlyStables, ownAddresses]);

  // Multi-select: набор выбранных hash'ей операций.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [currency, setCurrency] = useState<FiatCurrency>("RUB");
  const [totalFiatStr, setTotalFiatStr] = useState("");

  const totalFiat = Number(totalFiatStr.replace(/\s/g, "").replace(",", "."));
  const validFiat = Number.isFinite(totalFiat) && totalFiat > 0;

  // Owner-решение 2026-06-10: курс ₽/$ вручную НЕ нужен. Стартовый капитал в $
  // = СТОИМОСТЬ полученного: стейбл → номинал ($1/токен), USD-фиат → сама
  // сумма. Курс ЦБ давал курсовую фикцию (см. одиночный диалог).
  const isUsd = currency === "USD";

  // Ключ ops для multi-select.
  const opKey = (u: UnmarkedOp) => `${u.walletId}|${u.chain}|${u.hash}`;

  // Выбранные операции и их сводка.
  const selectedOps = unmarked.filter((u) => selected.has(opKey(u)));
  const selectedTotalTokenAmount = selectedOps.reduce(
    (s, o) => s + o.amount,
    0,
  );
  const selectedTotalCount = selectedOps.length;
  // Группировка выбранных по семейству — для контроля смешения токенов.
  const selectedFamilies = new Set(selectedOps.map((o) => o.family));

  // Эффективный курс: общая_сумма_фиата / общее_кол-во_токенов.
  const effectiveRate =
    validFiat && selectedTotalTokenAmount > 0
      ? totalFiat / selectedTotalTokenAmount
      : 0;

  // $-стоимость выбранного (стартовый капитал): USD-фиат → сама сумма;
  // иначе → Σ номиналов стейблов ($1/токен). Non-stable в $ не оценивается.
  const selectedStableAmount = selectedOps.reduce(
    (s, o) => s + (o.isStable ? o.amount : 0),
    0,
  );
  const hasNonStableSelected = selectedOps.some((o) => !o.isStable);
  const totalUsd = isUsd ? totalFiat : selectedStableAmount;
  // Подразумеваемый курс фиат/$ — для прозрачности (Σ фиата / $-стоимость).
  const impliedUsdRate =
    !isUsd && totalUsd > 0 && validFiat ? totalFiat / totalUsd : 0;

  // Сбрасываем selected когда меняются фильтры (отбрасываем ops которые
  // больше не видны).
  useEffect(() => {
    const validKeys = new Set(unmarked.map(opKey));
    setSelected((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (validKeys.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hideSpam, onlyExternal, onlyStables]);

  const toggleSelected = (key: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  };
  const selectAll = () => setSelected(new Set(unmarked.map(opKey)));
  const clearAll = () => setSelected(new Set());

  const apply = () => {
    if (!validFiat || selectedOps.length === 0) return;
    setAnnotations((prev) => {
      const next = { ...prev };
      for (const u of selectedOps) {
        const k = annotationKey({
          walletId: u.walletId,
          chain: u.chain,
          hash: u.hash,
        });
        // Защита: не перезаписываем существующую fiat-аннотацию.
        if (next[k]?.fiatPurchase) continue;
        const fiatAmt = u.amount * effectiveRate;
        const fp: FiatPurchaseAnnotation = {
          fiatAmount: fiatAmt,
          fiatCurrency: currency,
        };
        // $-эквивалент (стартовый капитал) = стоимость полученного:
        // USD-фиат → fiatAmt; стейбл → номинал ($1/токен); non-stable → не
        // пишем (metrics-фолбэк). Курс ₽/$ больше не спрашиваем.
        if (isUsd) {
          fp.usdAmount = fiatAmt;
        } else if (u.isStable) {
          fp.usdAmount = u.amount;
          if (u.amount > 0) fp.usdRate = fiatAmt / u.amount;
        }
        next[k] = {
          ...(next[k] ?? {}),
          fiatPurchase: fp,
        };
      }
      return next;
    });
    onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={
        <span className="inline-flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-emerald-400" />
          Массовая разметка фиата
        </span>
      }
      description="Выберите одну или несколько операций и укажите ОБЩУЮ сумму потраченного фиата. Сумма распределится пропорционально между всеми выбранными (общий эффективный курс)."
      footer={
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            disabled={!validFiat || selectedTotalCount === 0}
            onClick={apply}
          >
            Применить ({selectedTotalCount} опер.)
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-secondary/40 p-2 text-xs">
          <FilterChip checked={onlyStables} onChange={setOnlyStables}>
            Только стейблы
          </FilterChip>
          <FilterChip checked={onlyExternal} onChange={setOnlyExternal}>
            Только извне
          </FilterChip>
          <FilterChip checked={hideSpam} onChange={setHideSpam}>
            Скрыть спам
          </FilterChip>
        </div>

        {unmarked.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            Нет неразмеченных поступлений по этим фильтрам.
          </div>
        ) : (
          <>
            {/* Плоский список операций (как в реестре) с multi-select */}
            <div>
              <div className="mb-1 flex items-center justify-between">
                <Label>
                  Операции{" "}
                  <span className="text-[10px] text-muted-foreground">
                    ({unmarked.length})
                  </span>
                </Label>
                <div className="flex gap-1.5 text-[10px] uppercase">
                  <button
                    type="button"
                    onClick={selectAll}
                    className="rounded px-2 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    выбрать все
                  </button>
                  <button
                    type="button"
                    onClick={clearAll}
                    className="rounded px-2 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    очистить
                  </button>
                </div>
              </div>
              <div className="max-h-72 divide-y divide-border/40 overflow-y-auto rounded-md border border-border bg-secondary/40">
                {unmarked.map((u) => {
                  const k = opKey(u);
                  const isSel = selected.has(k);
                  return (
                    <label
                      key={k}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-xs transition-colors",
                        isSel
                          ? "bg-emerald-500/10 text-foreground"
                          : "hover:bg-accent/60",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={isSel}
                        onChange={() => toggleSelected(k)}
                        className="h-3.5 w-3.5 flex-shrink-0 cursor-pointer accent-emerald-500"
                      />
                      {/* Дата */}
                      <span className="flex-shrink-0 tabular-nums text-[10px] text-muted-foreground whitespace-nowrap">
                        {new Date(u.time * 1000).toLocaleString("ru-RU", {
                          day: "2-digit",
                          month: "2-digit",
                          year: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      {/* Кошелёк */}
                      <span
                        className={cn(
                          "flex-shrink-0 truncate rounded border border-border bg-background px-1.5 py-0.5 text-[10px] max-w-[140px]",
                          u.walletChain === "sol"
                            ? "text-[#14F195]"
                            : "text-brand-cyan",
                        )}
                        title={u.walletName}
                      >
                        {u.walletName}
                      </span>
                      {/* Сеть */}
                      <span className="flex-shrink-0 rounded border border-border bg-background px-1.5 py-0.5 text-[9px] uppercase text-muted-foreground">
                        {u.chain}
                      </span>
                      {/* Сумма + токен */}
                      <span className="ml-auto inline-flex flex-shrink-0 items-center gap-1.5 tabular-nums">
                        <span className="font-semibold text-emerald-400">
                          + {formatNumber(u.amount, locale, 4)}
                        </span>
                        <span className="font-mono text-muted-foreground">
                          {u.symbol}
                        </span>
                        {u.isStable && (
                          <span className="rounded bg-secondary px-1 text-[9px] uppercase text-muted-foreground">
                            стейбл
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* Currency + total fiat */}
            <div className="grid grid-cols-[120px_1fr] gap-2">
              <div>
                <Label htmlFor="bm-cur">Валюта</Label>
                <select
                  id="bm-cur"
                  value={currency}
                  onChange={(e) =>
                    setCurrency(e.target.value as FiatCurrency)
                  }
                  className="h-10 w-full rounded-md border border-border bg-background px-2 text-sm"
                >
                  {COMMON_FIAT_CURRENCIES.map((f) => (
                    <option key={f.code} value={f.code}>
                      {f.symbol} {f.code}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label htmlFor="bm-total">
                  Общая сумма фиата
                  {selectedTotalCount > 0 && (
                    <span className="ml-1 text-[10px] text-muted-foreground">
                      на все {selectedTotalCount} опер.
                    </span>
                  )}
                </Label>
                <Input
                  id="bm-total"
                  autoFocus
                  inputMode="decimal"
                  value={totalFiatStr}
                  onChange={(e) => setTotalFiatStr(e.target.value)}
                  placeholder="200 000"
                />
              </div>
            </div>

            {/* Превью */}
            {validFiat && selectedTotalCount > 0 && (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs">
                <div className="text-muted-foreground">Эффективный курс:</div>
                <div className="mt-0.5 font-semibold text-emerald-400 tabular-nums">
                  {formatNumber(effectiveRate, locale, 4)}{" "}
                  {fiatSymbol(currency)} за 1 ед.{" "}
                  <span className="font-normal text-muted-foreground">
                    ({[...selectedFamilies].join(" + ")})
                  </span>
                </div>
                <div className="mt-1 text-muted-foreground">
                  Всего {selectedTotalCount} оп. ·{" "}
                  {formatNumber(selectedTotalTokenAmount, locale, 2)} токенов
                  ·{" "}
                  <span className="font-medium text-emerald-400">
                    {formatFiat(
                      totalFiat,
                      currency,
                      locale === "en" ? "en" : "ru",
                    )}
                  </span>
                </div>
                {!isUsd && totalUsd > 0 && (
                  <div className="mt-1 text-muted-foreground">
                    Стартовый капитал:{" "}
                    <span className="font-medium text-emerald-400 tabular-nums">
                      ${formatNumber(totalUsd, locale, 2)}
                    </span>{" "}
                    <span className="text-[10px]">
                      (номинал стейблов · курс{" "}
                      {formatNumber(impliedUsdRate, locale, 2)}{" "}
                      {fiatSymbol(currency)}/$)
                    </span>
                  </div>
                )}
                {hasNonStableSelected && !isUsd && (
                  <div className="mt-1 text-[10px] text-warning">
                    В выборе есть не-стейбл токены — их $-стоимость здесь не
                    фиксируется (только стейблы идут по номиналу).
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

function FilterChip({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label
      className={cn(
        "inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2 py-0.5 transition-colors",
        checked
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
          : "border-border bg-background text-muted-foreground hover:text-foreground",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3 w-3 cursor-pointer accent-emerald-500"
      />
      {children}
    </label>
  );
}
