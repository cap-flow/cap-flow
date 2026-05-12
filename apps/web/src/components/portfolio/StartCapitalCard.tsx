/**
 * Карточка «Стартовый капитал» — сводка по ручным пометкам покупок крипты
 * за фиат (см. FiatPurchaseCell в реестре операций). Показывает:
 *  - Σ потраченного по каждой фиат-валюте (нельзя складывать ₽ и $)
 *  - Средневзвешенный курс покупки по каждому токену
 *
 * Используется на дашборде (HomePage) — даёт пользователю понимание
 * сколько он реально вложил в крипту в фиатных деньгах.
 */

import { useMemo } from "react";
import { Banknote } from "lucide-react";

import { Tooltip } from "@/components/ui/Tooltip";
import {
  annotationKey,
  fiatSymbol,
  formatFiat,
  useOpAnnotations,
  type FiatCurrency,
} from "@/lib/portfolio/manual_annotations";
import type { ClassifiedOp } from "@/lib/portfolio/types";
import type { SavedWallet } from "@/lib/wallets";
import { formatNumber } from "@/i18n/format";
import { useI18n } from "@/i18n/I18nProvider";
import { Info } from "lucide-react";

interface StartCapitalCardProps {
  /** Список загруженных кошельков с их историей операций. */
  loadedList: { wallet: SavedWallet; ops: ClassifiedOp[] }[];
}

export function StartCapitalCard({ loadedList }: StartCapitalCardProps) {
  const { locale } = useI18n();
  const [annotations] = useOpAnnotations();

  type TokenAgg = { tokenAmount: number; fiatSum: number; count: number };
  type CurAgg = { totalFiat: number; opsCount: number; tokens: Map<string, TokenAgg> };
  const byCurrency = useMemo(() => {
    const m = new Map<FiatCurrency, CurAgg>();
    // Считаем КАЖДУЮ ручную метку «куплено за фиат» — независимо от
    // op.type. Раньше фильтр на `transfer_in` отбрасывал свапы и прочие
    // помеченные операции, из-за чего total в карточке расходился с
    // фактическим количеством меток в реестре.
    for (const l of loadedList) {
      for (const op of l.ops) {
        const k = annotationKey({
          walletId: l.wallet.id,
          chain: op.chain,
          hash: op.hash,
        });
        const ann = annotations[k];
        const p = ann?.fiatPurchase;
        if (!p) continue;
        const cur = m.get(p.fiatCurrency) ?? {
          totalFiat: 0,
          opsCount: 0,
          tokens: new Map(),
        };
        cur.totalFiat += p.fiatAmount;
        cur.opsCount += 1;
        // Per-token агрегация — только если есть входящее движение.
        const inMv = op.movement.find(
          (mv) => mv.direction === "in" && mv.amount > 0,
        );
        if (inMv) {
          const sym = inMv.symbol.toUpperCase();
          const tok = cur.tokens.get(sym) ?? {
            tokenAmount: 0,
            fiatSum: 0,
            count: 0,
          };
          tok.tokenAmount += inMv.amount;
          tok.fiatSum += p.fiatAmount;
          tok.count += 1;
          cur.tokens.set(sym, tok);
        }
        m.set(p.fiatCurrency, cur);
      }
    }
    return m;
  }, [loadedList, annotations]);

  return (
    <div className="relative overflow-hidden rounded-xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/5 via-card to-card shadow-sm">
      <span className="pointer-events-none absolute inset-x-6 -top-px h-px bg-emerald-500/50 opacity-80" />
      {/* Шапка */}
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-400">
          <Banknote className="h-4 w-4" />
        </div>
        <div className="flex-1">
          <div className="text-sm font-semibold tracking-tight text-foreground">
            Стартовый капитал
          </div>
          <div className="text-[11px] text-muted-foreground">
            Сколько фиата вложено в крипту
          </div>
        </div>
        <Tooltip
          maxWidth={320}
          content={
            <div className="space-y-1">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-emerald-400">
                Стартовый капитал
              </div>
              <div className="text-xs leading-relaxed text-foreground/90">
                Собирается из ручных пометок «куплено за фиат» в реестре
                операций. По каждой фиат-валюте — суммарно потрачено и
                средневзвешенный курс покупки по каждому токену.
              </div>
            </div>
          }
        >
          <span className="inline-flex h-5 w-5 cursor-help items-center justify-center rounded-full text-muted-foreground/80 transition-colors hover:bg-emerald-500/15 hover:text-emerald-400">
            <Info className="h-3.5 w-3.5" />
          </span>
        </Tooltip>
      </div>

      {/* Контент */}
      {byCurrency.size === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          Пока ничего не размечено.
          <br />
          В{" "}
          <a className="text-emerald-400 hover:underline" href="/registry">
            Реестре операций
          </a>{" "}
          у каждого `transfer_in`'а есть кнопка{" "}
          <span className="rounded border border-dashed border-emerald-500/40 px-1 text-[10px] text-emerald-400">
            куплено за фиат
          </span>
          {" "}— укажи сколько ты заплатил за каждое поступление.
        </div>
      ) : (
        <div className="space-y-3 p-4">
          {[...byCurrency.entries()].map(([cur, agg]) => (
            <div key={cur} className="space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <div className="text-xs font-semibold uppercase tracking-wider text-foreground">
                  Потрачено в {cur}
                </div>
                <div className="text-lg font-bold text-emerald-400 tabular-nums">
                  {formatFiat(
                    agg.totalFiat,
                    cur,
                    locale === "en" ? "en" : "ru",
                  )}
                </div>
              </div>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                {[...agg.tokens.entries()]
                  .sort((a, b) => b[1].fiatSum - a[1].fiatSum)
                  .map(([sym, t]) => {
                    const avgRate =
                      t.tokenAmount > 0 ? t.fiatSum / t.tokenAmount : 0;
                    return (
                      <div
                        key={sym}
                        className="rounded-lg border border-border bg-secondary/40 p-2.5"
                      >
                        <div className="flex items-baseline justify-between">
                          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            {sym}
                          </span>
                          <span className="text-[9px] text-muted-foreground">
                            {t.count}{" "}
                            {t.count === 1 ? "покупка" : "покупок"}
                          </span>
                        </div>
                        <div className="mt-0.5 flex items-baseline gap-1.5">
                          <span className="text-sm font-semibold tabular-nums">
                            {formatNumber(t.tokenAmount, locale, 4)}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            {sym}
                          </span>
                        </div>
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          курс:{" "}
                          <span className="font-medium text-emerald-400 tabular-nums">
                            {formatNumber(avgRate, locale, 4)}{" "}
                            {fiatSymbol(cur)}
                          </span>{" "}
                          / {sym}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          вложено{" "}
                          <span className="tabular-nums">
                            {formatFiat(
                              t.fiatSum,
                              cur,
                              locale === "en" ? "en" : "ru",
                            )}
                          </span>
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
