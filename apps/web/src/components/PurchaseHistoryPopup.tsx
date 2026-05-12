/**
 * Popup с историей **покупок** underlying токенов lending позиции.
 *
 * Показывает ТОЛЬКО события-покупки (affectsWac=true): swap_from_stable,
 * swap_from_token, fiat_buy, lp_close_attribution. Transfer_in / sells /
 * deploy скрыты — они не влияют на WAC.
 *
 * UX:
 *  - Размер md (не закрывает весь экран)
 *  - Внутренний скролл по таблице
 *  - Шрифт нормального размера (text-xs/text-sm, не text-[10/11px])
 */

import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

import { Dialog } from "@/components/ui/dialog";
import { useLotMethodology } from "@/lib/lot_methodology";
import { LotMethodologyHelpDialog } from "./LotMethodologyHelpDialog";
import { formatNumber, formatUsd } from "@/i18n/format";
import {
  getPurchaseHistory,
  summarizeWac,
  type PurchaseEvent,
  type PurchaseEventKind,
} from "@/lib/portfolio/purchase_history";
import { getPositionLotCostBasis } from "@/lib/portfolio/position_lot_cost_basis";
import { getActualSuppliedTokens } from "@/lib/portfolio/actual_supplied_tokens";
import type { ClassifiedOp } from "@/lib/portfolio/types";

const KIND_LABEL: Record<PurchaseEventKind, string> = {
  swap_from_stable: "За стейбл",
  swap_from_token: "Своп с токена",
  fiat_buy: "Фиат",
  lp_close_attribution: "Из LP",
  transfer_in: "Перевод",
  sell_to_stable: "Продажа",
  sell_to_token: "Своп",
  transfer_out: "Расход",
  deploy: "В позицию",
  other: "Прочее",
};

const KIND_COLOR: Record<PurchaseEventKind, string> = {
  swap_from_stable: "text-success",
  swap_from_token: "text-brand-cyan",
  fiat_buy: "text-warning",
  lp_close_attribution: "text-violet-400",
  transfer_in: "text-muted-foreground",
  sell_to_stable: "text-destructive",
  sell_to_token: "text-orange-400",
  transfer_out: "text-muted-foreground",
  deploy: "text-blue-400",
  other: "text-muted-foreground",
};

export interface PurchaseHistoryPopupProps {
  open: boolean;
  onClose: () => void;
  supplyTokens: { symbol: string; amount: number }[];
  ops: ClassifiedOp[];
  locale: "en" | "ru";
  startUsdShown: number;
  positionLabel: string;
  /** walletId — для lot-aware cost basis (FIFO). */
  walletId: string;
  /** protocolId — для фильтрации lend_supply ops в lot tracking. */
  protocolId: string;
  /** chain — для фильтрации lend_supply ops. */
  chain: string;
  histPrices?: Map<string, number>;
}

export function PurchaseHistoryPopup({
  open,
  onClose,
  supplyTokens,
  ops,
  locale,
  startUsdShown,
  positionLabel,
  walletId,
  protocolId,
  chain,
  histPrices,
}: PurchaseHistoryPopupProps) {
  const [methodologyOpen, setMethodologyOpen] = useState(false);
  const [helpDialogOpen, setHelpDialogOpen] = useState(false);
  // Используем ГЛОБАЛЬНУЮ методологию (persist в localStorage). Toggle в
  // popup'е меняет её для всей страницы — Стартовая $ в таблице тоже
  // обновится. Это даёт consistent view: то что видишь в popup'е по
  // выбранной методике совпадает с тем что показано в столбце.
  const [lotMethodology, setLotMethodology] = useLotMethodology();
  const perSymbol = useMemo(() => {
    // Реально задепонированные токены (для receipt-token позиций — GLV
    // вместо decomposed WETH+USDC). Если найдены — используем их;
    // иначе fallback на supplyTokens из DeBank.
    const actualTokens = getActualSuppliedTokens(
      ops,
      protocolId,
      chain,
      supplyTokens.map((t) => t.symbol),
    );
    const tokensToShow =
      actualTokens.length > 0
        ? actualTokens.map((t) => ({ symbol: t.symbol, amount: t.netAmount }))
        : supplyTokens;
    return tokensToShow.map((t) => {
      const allEvents = getPurchaseHistory(ops, t.symbol, histPrices);
      const events = allEvents.filter((e) => e.affectsWac);
      const wac = summarizeWac(allEvents, ops, t.symbol, histPrices);
      // Lot-aware breakdown — для информационного отображения «какие lots
      // ушли в позицию» по выбранной методике (FIFO/LIFO/WAC toggle).
      // Это audit-trail; для расчёта startUsd используется простая
      // кумулятивная WAC ниже.
      const lotCb = getPositionLotCostBasis({
        ops,
        walletId,
        protocolId,
        chain,
        symbol: t.symbol,
        currentAmount: t.amount,
        methodology: lotMethodology,
        ...(histPrices && { histPrices }),
      });
      const effectiveWac =
        lotCb.effectiveWac > 0
          ? lotCb.effectiveWac
          : wac.currentTrackerWac ?? wac.wac;
      const coveragePct =
        t.amount > 0 ? (wac.totalAmountBought / t.amount) * 100 : 0;
      const wacBasedStartUsd = t.amount * effectiveWac;
      const honestSpentUsd = wac.totalCostUsd;
      return {
        ...t,
        events,
        wac,
        effectiveWac,
        wacBasedStartUsd,
        coveragePct,
        honestSpentUsd,
        lotCb,
      };
    });
  }, [ops, supplyTokens, histPrices, walletId, protocolId, chain, lotMethodology]);

  const totalWacBased = perSymbol.reduce((s, p) => s + p.wacBasedStartUsd, 0);
  const totalHonestSpent = perSymbol.reduce((s, p) => s + p.honestSpentUsd, 0);
  const totalAmount = perSymbol.reduce((s, p) => s + p.amount, 0);
  const totalBought = perSymbol.reduce(
    (s, p) => s + p.wac.totalAmountBought,
    0,
  );
  const overallCoverage =
    totalAmount > 0 ? (totalBought / totalAmount) * 100 : 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={
        <div className="flex flex-col gap-0.5">
          <span className="text-sm">История покупок underlying</span>
          <span className="text-xs font-normal text-muted-foreground">
            {positionLabel}
          </span>
        </div>
      }
    >
      <div className="flex max-h-[80vh] flex-col gap-2 overflow-hidden text-sm">
        {/* Сворачиваемое пояснение методологии — по умолчанию свёрнуто */}
        <div className="shrink-0 rounded-md border border-brand-cyan/40 bg-brand-cyan/5 ring-1 ring-brand-cyan/10">
          <button
            type="button"
            onClick={() => setMethodologyOpen((v) => !v)}
            className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs hover:bg-brand-cyan/10 transition-colors"
          >
            <span className="flex items-center gap-2">
              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-cyan/20 text-brand-cyan font-bold">
                ?
              </span>
              <span>
                <span className="text-muted-foreground">Как считается</span>{" "}
                <strong className="text-brand-cyan">Стартовая $</strong>{" "}
                <span className="text-muted-foreground">
                  — подробнее о WAC методологии
                </span>
              </span>
            </span>
            <span className="inline-flex items-center gap-1 text-brand-cyan font-medium">
              {methodologyOpen ? "свернуть" : "раскрыть"}
              {methodologyOpen ? (
                <ChevronUp className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 shrink-0" />
              )}
            </span>
          </button>
          {methodologyOpen && (
            <div className="border-t border-border/60 px-3 py-2.5 text-xs leading-relaxed">
              <p className="mb-2">
                <strong className="text-foreground">Стартовая $</strong> —
                это сумма ваших <strong>реальных трат</strong> на покупку
                токенов, которые сейчас лежат в позиции.
              </p>
              <p className="mb-1.5 font-mono text-[11px] text-muted-foreground">
                Стартовая $ = current_amount × cost_per_unit
              </p>

              {/* Что считается покупкой / нет */}
              <p className="mb-1 font-medium text-foreground">
                ✅ Что считается покупкой (влияет на cost basis):
              </p>
              <ul className="mb-2 ml-4 list-disc space-y-0.5 text-[11px] text-muted-foreground">
                <li>
                  <span className="text-success font-medium">За стейбл</span>{" "}
                  — USDT/USDC → ETH (1000 USDT → 0.43 ETH ⇒ $2,326/ETH)
                </li>
                <li>
                  <span className="text-brand-cyan font-medium">
                    Своп с токена
                  </span>{" "}
                  — BTC → ETH. Cost ETH = WAC_BTC × отданное_BTC ÷
                  полученное_ETH
                </li>
                <li>
                  <span className="text-warning font-medium">Фиат</span> —
                  ручная пометка «куплено за фиат» в Реестре
                </li>
                <li>
                  <span className="text-violet-400 font-medium">Из LP</span>{" "}
                  — токены из закрытой LP с оригинальным cost basis
                </li>
              </ul>
              <p className="mb-1 font-medium text-foreground">
                ❌ Что НЕ влияет:
              </p>
              <ul className="mb-3 ml-4 list-disc space-y-0.5 text-[11px] text-muted-foreground">
                <li>
                  <strong>Перевод</strong> — transfer не покупка
                </li>
                <li>
                  <strong>Продажа</strong> — реализует PnL, средняя
                  сохраняется
                </li>
                <li>
                  <strong>В позицию</strong> (lend_supply / lp_add) —
                  deployment, не отчуждение
                </li>
              </ul>

              {/* Методики lot-tracking — компактный summary + кнопка
                  на полное объяснение */}
              <div className="mb-2 rounded border border-brand-cyan/30 bg-brand-cyan/5 px-3 py-2.5">
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <p className="font-semibold text-brand-cyan">
                    📦 Методики выбора lots
                  </p>
                  <button
                    type="button"
                    onClick={() => setHelpDialogOpen(true)}
                    className="inline-flex items-center gap-1 rounded-full border border-brand-cyan/40 bg-brand-cyan/10 px-2 py-0.5 text-[11px] font-semibold text-brand-cyan hover:bg-brand-cyan/20 transition-colors"
                  >
                    ? Подробнее с примерами
                  </button>
                </div>
                <p className="mb-2 text-[11px] text-muted-foreground">
                  Каждая покупка — отдельная «партия» (lot) со своей ценой.
                  Когда тратите токен — нужно решить из какой партии
                  вычесть.
                </p>
                <ul className="space-y-1 text-[11px] text-muted-foreground">
                  <li>
                    <strong className="text-success">FIFO</strong> —
                    старые партии уходят первыми (рекомендуется)
                  </li>
                  <li>
                    <strong className="text-orange-400">LIFO</strong> —
                    новые партии уходят первыми
                  </li>
                  <li>
                    <strong className="text-brand-cyan">WAC</strong> —
                    усреднение всех lots по средней цене
                  </li>
                </ul>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Toggle ниже ⬇️ переключает методику для всей страницы и
                  popup'а. Стартовая $ в таблице обновится автоматически.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Methodology toggle (FIFO / LIFO / WAC) */}
        <div className="shrink-0 flex items-center gap-2 rounded-md border border-border/60 bg-secondary/20 px-3 py-2 text-xs">
          <span className="text-muted-foreground">Методика подсчёта lots:</span>
          <div className="ml-auto flex gap-1">
            {(["FIFO", "LIFO", "WAC"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setLotMethodology(m)}
                className={`rounded px-2 py-1 text-[11px] font-semibold transition-colors ${
                  lotMethodology === m
                    ? "bg-brand-cyan/20 text-brand-cyan border border-brand-cyan/40"
                    : "text-muted-foreground hover:text-foreground border border-border"
                }`}
                title={
                  m === "FIFO"
                    ? "First In, First Out: старейшие покупки уходят при spend первыми. В позиции остаются НОВЫЕ lots."
                    : m === "LIFO"
                      ? "Last In, First Out: новейшие покупки уходят первыми. В позиции остаются СТАРЫЕ lots."
                      : "Weighted Average: усредняет все покупки в одну среднюю цену (старая методика)."
                }
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        {/* Per-symbol details — scroll внутри */}
        <div className="flex-1 space-y-3 overflow-y-auto">
          {perSymbol.map((sym) => (
            <div
              key={sym.symbol}
              className="rounded-md border border-border bg-card"
            >
              <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2">
                <div>
                  <div className="text-sm font-bold">{sym.symbol}</div>
                  <div className="text-xs text-muted-foreground">
                    В позиции:{" "}
                    <strong className="text-foreground">
                      {formatNumber(sym.amount, locale, 6)} {sym.symbol}
                    </strong>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Куплено:{" "}
                    <strong
                      className={
                        sym.coveragePct < 50
                          ? "text-warning"
                          : "text-foreground"
                      }
                    >
                      {formatNumber(sym.wac.totalAmountBought, locale, 6)}{" "}
                      {sym.symbol}
                    </strong>{" "}
                    ({sym.coveragePct.toFixed(1)}% покрытие)
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    WAC ПОКУПКИ
                  </div>
                  <div className="text-sm font-bold tabular-nums">
                    {sym.effectiveWac > 0
                      ? formatUsd(sym.effectiveWac, locale)
                      : "—"}
                  </div>
                  <div className="text-xs tabular-nums text-muted-foreground">
                    {sym.wac.purchasesCount} покупок ·{" "}
                    {formatUsd(sym.wac.totalCostUsd, locale)}
                  </div>
                </div>
              </div>
              {/* Warning если покрытие низкое */}
              {sym.coveragePct < 95 && sym.wac.totalAmountBought > 0 && (
                <div className="border-b border-warning/30 bg-warning/5 px-3 py-2 text-xs">
                  <div className="font-medium text-warning">
                    ⚠️ Покрытие покупками только {sym.coveragePct.toFixed(1)}%
                  </div>
                  <div className="mt-0.5 text-muted-foreground">
                    Из {formatNumber(sym.amount, locale, 6)} {sym.symbol} в позиции
                    только{" "}
                    <strong>
                      {formatNumber(sym.wac.totalAmountBought, locale, 6)}
                    </strong>{" "}
                    были куплены ($
                    {formatNumber(sym.wac.totalCostUsd, locale, 2)}). Остальные{" "}
                    <strong>
                      {formatNumber(
                        sym.amount - sym.wac.totalAmountBought,
                        locale,
                        6,
                      )}{" "}
                      {sym.symbol}
                    </strong>{" "}
                    пришли через transfer_in / lp_remove / другие источники.
                    «Стартовая $» по WAC экстраполирует cost basis на ВСЁ кол-во
                    — это приближение.
                  </div>
                </div>
              )}

              {/* Events table — только покупки */}
              {sym.events.length > 0 ? (
                <table className="w-full text-xs">
                  <thead className="bg-secondary/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-3 py-1.5 text-left">Дата</th>
                      <th className="px-3 py-1.5 text-left">Тип</th>
                      <th className="px-3 py-1.5 text-right">Кол-во</th>
                      <th
                        className="px-3 py-1.5 text-right"
                        title="Cost basis price = costUsd / amount. Для swap_from_token может отличаться от market — это WAC отданного токена / получ."
                      >
                        Cost
                      </th>
                      <th
                        className="px-3 py-1.5 text-right"
                        title="Рыночная цена токена в момент op (DefiLlama hist)"
                      >
                        Market
                      </th>
                      <th className="px-3 py-1.5 text-right">USD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sym.events.map((e: PurchaseEvent, idx) => {
                      const date = new Date(e.time * 1000);
                      const dateStr = date.toLocaleDateString(
                        locale === "ru" ? "ru-RU" : "en-US",
                      );
                      const counterpartTitle = e.counterpart
                        ? `Отдали: ${formatNumber(e.counterpart.amount, locale, 6)} ${e.counterpart.symbol}`
                        : undefined;
                      // Highlight if cost diverges significantly from market.
                      const divergent =
                        e.marketPriceAtOp != null &&
                        e.marketPriceAtOp > 0 &&
                        e.pricePerUnit > 0 &&
                        Math.abs(e.pricePerUnit - e.marketPriceAtOp) /
                          e.marketPriceAtOp >
                          0.15;
                      return (
                        <tr
                          key={`${e.hash}-${idx}`}
                          className="border-t border-border/40 hover:bg-success/5"
                        >
                          <td className="px-3 py-1 text-muted-foreground whitespace-nowrap">
                            {dateStr}
                          </td>
                          <td
                            className={`px-3 py-1 ${KIND_COLOR[e.kind]}`}
                            title={counterpartTitle}
                          >
                            {KIND_LABEL[e.kind]}
                          </td>
                          <td className="px-3 py-1 text-right tabular-nums">
                            +{formatNumber(e.amount, locale, 6)}
                          </td>
                          <td
                            className={`px-3 py-1 text-right tabular-nums ${
                              divergent ? "text-warning" : "text-muted-foreground"
                            }`}
                            title={
                              divergent
                                ? `Cost basis price отличается от market — WAC отданного токена выше/ниже рыночной`
                                : undefined
                            }
                          >
                            {formatUsd(e.pricePerUnit, locale)}
                          </td>
                          <td className="px-3 py-1 text-right tabular-nums text-muted-foreground/70">
                            {e.marketPriceAtOp != null
                              ? formatUsd(e.marketPriceAtOp, locale)
                              : "—"}
                          </td>
                          <td className="px-3 py-1 text-right tabular-nums font-medium">
                            {formatUsd(e.costUsd, locale)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <div className="px-3 py-3 text-xs text-muted-foreground">
                  Нет событий-покупок (только переводы / продажи / deploy).
                </div>
              )}

              {/* Какие именно lots попали в позицию (lot-aware breakdown) */}
              {sym.lotCb.consumedLots.length > 0 && (
                <div className="border-t border-success/30 bg-success/5 px-3 py-2 text-xs">
                  <div className="mb-1 font-medium text-success">
                    📦 Lots в позиции по методике {lotMethodology}:
                  </div>
                  <div className="max-h-36 overflow-y-auto space-y-0.5">
                    {(() => {
                      const grouped = new Map<
                        number,
                        { time: number; costPerUnit: number; amount: number }
                      >();
                      for (const c of sym.lotCb.consumedLots) {
                        const cur = grouped.get(c.purchaseTime) ?? {
                          time: c.purchaseTime,
                          costPerUnit: c.costPerUnit,
                          amount: 0,
                        };
                        cur.amount += c.amount;
                        grouped.set(c.purchaseTime, cur);
                      }
                      return [...grouped.values()]
                        .sort((a, b) => a.time - b.time)
                        .map((g, idx) => {
                          const date = new Date(g.time * 1000).toLocaleDateString(
                            locale === "ru" ? "ru-RU" : "en-US",
                          );
                          return (
                            <div
                              key={idx}
                              className="flex items-center justify-between gap-2 tabular-nums"
                            >
                              <span className="text-muted-foreground w-20 shrink-0">
                                {date}
                              </span>
                              <span className="flex-1 text-right">
                                {formatNumber(g.amount, locale, 6)} {sym.symbol}
                              </span>
                              <span className="text-muted-foreground w-20 text-right">
                                × {formatUsd(g.costPerUnit, locale)}
                              </span>
                              <span className="font-medium w-20 text-right">
                                {formatUsd(g.amount * g.costPerUnit, locale)}
                              </span>
                            </div>
                          );
                        });
                    })()}
                  </div>
                </div>
              )}

              {/* Per-symbol summary */}
              {sym.effectiveWac > 0 && (
                <div className="border-t border-border/60 bg-secondary/20 px-3 py-2 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      {formatNumber(sym.amount, locale, 6)} {sym.symbol} ×{" "}
                      {formatUsd(sym.effectiveWac, locale)} ({lotMethodology})
                    </span>
                    <span className="font-bold tabular-nums">
                      = {formatUsd(sym.wacBasedStartUsd, locale)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Aggregate comparison — sticky bottom */}
        <div className="shrink-0 rounded-md border border-brand-cyan/30 bg-brand-cyan/5 px-3 py-2 text-xs">
          <div className="flex justify-between py-0.5">
            <span className="text-muted-foreground">
              Стартовая $ (в таблице)
            </span>
            <span className="font-mono font-bold tabular-nums">
              {formatUsd(startUsdShown, locale)}
            </span>
          </div>
          <div className="flex justify-between py-0.5">
            <span className="text-muted-foreground">
              По WAC × current_amount{" "}
              {overallCoverage < 95 && (
                <span className="text-warning">
                  ({overallCoverage.toFixed(0)}% покрытие)
                </span>
              )}
            </span>
            <span className="font-mono font-bold tabular-nums">
              {formatUsd(totalWacBased, locale)}
            </span>
          </div>
          <div className="flex justify-between py-0.5">
            <span className="text-muted-foreground">
              Реально потрачено на покупки
            </span>
            <span
              className={`font-mono font-bold tabular-nums ${overallCoverage < 95 ? "text-warning" : ""}`}
            >
              {formatUsd(totalHonestSpent, locale)}
            </span>
          </div>
          {overallCoverage < 95 && totalBought > 0 && (
            <p className="mt-1.5 border-t border-warning/30 pt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              ⚠️ Только{" "}
              <strong className="text-warning">
                {overallCoverage.toFixed(1)}%
              </strong>{" "}
              underlying токенов в позиции имеют историю покупок в этом
              кошельке. Остальное пришло через transfer_in (с другого
              кошелька) / lp_remove / другие источники без явной цены покупки.
            </p>
          )}
        </div>
      </div>
      <LotMethodologyHelpDialog
        open={helpDialogOpen}
        onClose={() => setHelpDialogOpen(false)}
      />
    </Dialog>
  );
}
