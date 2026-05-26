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
import {
  computePositionCoverage,
  enrichPurchaseEventsForCoverage,
  type CexCostBasisMatch,
  type EnrichedPurchaseEvent,
} from "@/lib/portfolio/position_coverage";
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
  /**
   * Cost basis от CEX-withdrawal-ов (по lowercase tx-hash). Если задано,
   * `transfer_in` события подменяющиеся с CEX-выводом получают атрибуцию
   * cost basis из биржевого WAC-пула (P2P → trades → withdrawals). Без
   * него такие переводы остаются «непокрытыми». См.
   * `useCexWithdrawalCostBasis()` хук + `cex.cost-basis.service.ts`.
   */
  cexCostBasisByHash?: ReadonlyMap<string, CexCostBasisMatch>;
  /**
   * UCB C4 merged overrides: A4 manual + D3 CEX + C2 fiat-hop + C3
   * cross-wallet inheritance. Применяется в `getPositionLotCostBasis`
   * чтобы lot-by-lot отображение совпадало с position summary
   * (LotTracker SoT). Без этого popup'е cost basis для inherited
   * lots показывался как market m.usd → расхождение с column в таблице.
   */
  costBasisOverrideByHash?: ReadonlyMap<string, number>;
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
  cexCostBasisByHash,
  costBasisOverrideByHash,
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
      // Расширенный список ивентов для отображения: direct buys +
      // CEX-matched transfer_in (с реальным cost basis из биржевого
      // WAC-пула) + lp_close_attribution + unmatched transfer_in (с
      // costSource='unknown', costUsd=0 — debug-режим, чтобы пользователь
      // видел сами hash'и непокрытых переводов и понимал почему coverage
      // низкое: возможно биржа не подключена / withdrawal не synced).
      const events = enrichPurchaseEventsForCoverage(
        allEvents,
        cexCostBasisByHash ?? new Map(),
        t.symbol,
        { includeUnmatched: true },
      );
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
        // UCB C4: SoT consistency — inherits A4/D3/C2/C3 overrides и
        // использует net supplied (исключает yield) для consume.
        useNetSuppliedAmount: true,
        ...(costBasisOverrideByHash && { costBasisOverrideByHash }),
        ...(histPrices && { histPrices }),
      });
      // Расширенное покрытие: direct buy + CEX-withdrawal inheritance + LP
      // unwind inheritance. Закрывает дыру когда токен пришёл с биржи
      // (P2P→trades→withdrawal) — без этого был бы "transfer_in без цены".
      const coverage = computePositionCoverage({
        totalAmount: t.amount,
        events: allEvents,
        cexCostBasisByHash: cexCostBasisByHash ?? new Map(),
        targetSymbol: t.symbol,
      });
      // UCB B7: правильный приоритет cost basis:
      //   1. `coverage.wac` (direct + CEX inheritance + LP unwind) —
      //      это **реальные траты $$ / реальное amount**, honest UCB.
      //   2. `lotCb.effectiveWac` — FIFO lot tracker, использует m.usd
      //      DeBank spot для transfer_in → ВРАНЬЁ когда asset пришёл
      //      с CEX по carry-over cost basis ниже spot-цены.
      //   3. `wac.currentTrackerWac` — legacy fallback.
      // Раньше: lot_tracker > coverage → POS-007 показывал WAC $109,876
      // (= 0.176 × spot $110k + 0.005 × $99k) при реальной WAC $83,362
      // (= $14,723 / 0.1766). Теперь coverage.wac выигрывает первым.
      const effectiveWac =
        coverage.wac > 0
          ? coverage.wac
          : lotCb.effectiveWac > 0
            ? lotCb.effectiveWac
            : wac.currentTrackerWac ?? wac.wac;
      const directCoveragePct =
        t.amount > 0 ? (wac.totalAmountBought / t.amount) * 100 : 0;
      // UCB-correct startUsd:
      //   - Атрибутированная часть (covered) — используем РЕАЛЬНЫЕ траты
      //     (coverage.coveredUsd), без extrapolation на market.
      //   - Неатрибутированная часть (unknown amount) — extrapolate через
      //     effectiveWac (которая теперь = coverage.wac, тоже honest).
      // Так избегаем case'а «WAC × current = $19,407» когда реально
      // потрачено $14,723.
      const uncoveredAmount = Math.max(0, t.amount - coverage.coveredAmount);
      const wacBasedStartUsd =
        coverage.coveredUsd + uncoveredAmount * effectiveWac;
      const honestSpentUsd = coverage.coveredUsd;
      return {
        ...t,
        events,
        wac,
        effectiveWac,
        wacBasedStartUsd,
        coveragePct: coverage.coveragePct,
        directCoveragePct,
        honestSpentUsd,
        lotCb,
        coverage,
      };
    });
  }, [ops, supplyTokens, histPrices, walletId, protocolId, chain, lotMethodology, cexCostBasisByHash, costBasisOverrideByHash]);

  const totalWacBased = perSymbol.reduce((s, p) => s + p.wacBasedStartUsd, 0);
  const totalHonestSpent = perSymbol.reduce((s, p) => s + p.honestSpentUsd, 0);
  const totalAmount = perSymbol.reduce((s, p) => s + p.amount, 0);
  // Расширенное покрытие: direct + CEX inheritance + LP unwind.
  const totalCovered = perSymbol.reduce((s, p) => s + p.coverage.coveredAmount, 0);
  const overallCoverage =
    totalAmount > 0 ? Math.min(100, (totalCovered / totalAmount) * 100) : 0;
  // Сколько cost пришло из CEX и LP — для breakdown в footer'е.
  const totalCexInheritedUsd = perSymbol.reduce(
    (s, p) => s + p.coverage.cexInheritance.usd,
    0,
  );
  const totalLpInheritedUsd = perSymbol.reduce(
    (s, p) => s + p.coverage.lpUnwind.usd,
    0,
  );

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
      <div className="flex flex-col gap-2 text-sm">
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
                        sym.directCoveragePct < 50
                          ? "text-warning"
                          : "text-foreground"
                      }
                    >
                      {formatNumber(sym.wac.totalAmountBought, locale, 6)}{" "}
                      {sym.symbol}
                    </strong>{" "}
                    ({sym.directCoveragePct.toFixed(1)}%)
                  </div>
                  {/* Breakdown по источникам cost basis — показываем только
                      если есть что-то кроме direct buy. */}
                  {(sym.coverage.cexInheritance.amount > 0 ||
                    sym.coverage.lpUnwind.amount > 0) && (
                    <div className="text-[11px] text-muted-foreground space-y-0.5 mt-0.5">
                      {sym.coverage.cexInheritance.amount > 0 && (
                        <div title="Cost basis вытащен на бирже через P2P → trades → withdrawal. Hash match с CEX-withdrawal.">
                          С биржи:{" "}
                          <strong className="text-success">
                            {formatNumber(
                              sym.coverage.cexInheritance.amount,
                              locale,
                              6,
                            )}{" "}
                            {sym.symbol}
                          </strong>{" "}
                          ({formatUsd(sym.coverage.cexInheritance.usd, locale)})
                        </div>
                      )}
                      {sym.coverage.lpUnwind.amount > 0 && (
                        <div title="Cost basis унаследован от lp_add через cost_basis_tracker.">
                          Из LP:{" "}
                          <strong className="text-violet-400">
                            {formatNumber(sym.coverage.lpUnwind.amount, locale, 6)}{" "}
                            {sym.symbol}
                          </strong>{" "}
                          ({formatUsd(sym.coverage.lpUnwind.usd, locale)})
                        </div>
                      )}
                      <div className="text-foreground">
                        Итого покрытие:{" "}
                        <strong
                          className={
                            sym.coveragePct < 50
                              ? "text-warning"
                              : sym.coveragePct < 95
                                ? "text-foreground"
                                : "text-success"
                          }
                        >
                          {sym.coveragePct.toFixed(1)}%
                        </strong>
                      </div>
                    </div>
                  )}
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
                    {sym.events.length} ивентов ·{" "}
                    {formatUsd(sym.coverage.coveredUsd, locale)}
                  </div>
                </div>
              </div>
              {/* Warning если покрытие низкое (с учётом ВСЕХ источников).
                  Показываем и когда coveredAmount=0 — без cost basis вообще,
                  чтобы пользователь понимал что startUsd — extrapolation. */}
              {sym.coveragePct < 95 && (
                <div className="border-b border-warning/30 bg-warning/5 px-3 py-2 text-xs">
                  <div className="font-medium text-warning">
                    ⚠️ Покрытие cost basis только {sym.coveragePct.toFixed(1)}%
                  </div>
                  <div className="mt-0.5 text-muted-foreground">
                    Из <strong>{formatNumber(sym.amount, locale, 6)} {sym.symbol}</strong>{" "}
                    в позиции атрибутировано{" "}
                    <strong>
                      {formatNumber(sym.coverage.coveredAmount, locale, 6)}
                    </strong>{" "}
                    ($
                    {formatNumber(sym.coverage.coveredUsd, locale, 2)}: direct
                    buy + CEX-withdrawal + LP-unwind). Непокрыто{" "}
                    <strong>
                      {formatNumber(
                        Math.max(0, sym.amount - sym.coverage.coveredAmount),
                        locale,
                        6,
                      )}{" "}
                      {sym.symbol}
                    </strong>
                    {sym.coverage.unknown.count > 0 && (
                      <>
                        {" "}({sym.coverage.unknown.count} transfer_in без
                        match'а — см. таблицу ниже, помечены как «Перевод без
                        атрибуции»; наведи курсор для рекомендаций)
                      </>
                    )}
                    . «Стартовая $» экстраполирует cost basis на ВСЁ кол-во —
                    это приближение.
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
                    {sym.events.map((e: EnrichedPurchaseEvent, idx) => {
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
                      // Подменяем label/color по costSource: для CEX-matched
                      // transfer_in показываем "С биржи" (а не дефолтное
                      // «Перевод», который вводит в заблуждение — теперь
                      // транзакция имеет реальный cost basis).
                      // CEX-matched, но cost basis = 0 — это значит withdrawal
                      // нашёлся, но server-side WAC-пул пустой (нет trades /
                      // P2P для пары). Показываем как "С биржи" но без cost.
                      const cexNoCost =
                        e.costSource === "cex" && e.costUsd === 0;
                      const labelOverride =
                        e.costSource === "cex"
                          ? cexNoCost
                            ? "С биржи (нет cost)"
                            : "С биржи"
                          : e.costSource === "lp"
                            ? "Из LP"
                            : e.costSource === "unknown"
                              ? "Перевод без атрибуции"
                              : KIND_LABEL[e.kind];
                      const colorOverride =
                        e.costSource === "cex"
                          ? cexNoCost
                            ? "text-warning"
                            : "text-success"
                          : e.costSource === "lp"
                            ? "text-violet-400"
                            : e.costSource === "unknown"
                              ? "text-muted-foreground italic"
                              : KIND_COLOR[e.kind];
                      const sourceTooltip =
                        e.costSource === "cex"
                          ? cexNoCost
                            ? `Withdrawal найден на бирже (${e.inheritanceSource ?? "unknown"}), но cost basis = $0: WAC-пул на бирже пуст. Причина: на этой бирже не synced trades / P2P через которые asset был куплен. Что делать: 1) дать API-key permission "read trade history" на бирже (на BingX в скриншоте — false) 2) re-sync аккаунта 3) либо вручную пометить как фиатную покупку в Реестре. Hash: ${e.hash}`
                            : `Cost basis из CEX-withdrawal'а (${e.inheritanceSource ?? "unknown"}). Точность зависит от того, был ли фиатный leg в P2P-цепочке.`
                          : e.costSource === "lp"
                            ? "Cost basis унаследован от lp_add через cost_basis_tracker."
                            : e.costSource === "unknown"
                              ? `Этот transfer_in не нашёл match с CEX-withdrawal. Чтобы атрибутировать cost: 1) подключите биржу с которой пришёл этот transfer 2) запустите Sync Transfers — это вытащит withdrawal record с этим же tx-hash 3) либо отметьте как фиатную покупку в Реестре. Hash: ${e.hash}`
                              : counterpartTitle;
                      return (
                        <tr
                          key={`${e.hash}-${idx}`}
                          className="border-t border-border/40 hover:bg-success/5"
                        >
                          <td className="px-3 py-1 text-muted-foreground whitespace-nowrap">
                            {dateStr}
                          </td>
                          <td
                            className={`px-3 py-1 ${colorOverride}`}
                            title={sourceTooltip}
                          >
                            {labelOverride}
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
                            {e.costSource === "unknown" ||
                            (e.costSource === "cex" && e.costUsd === 0)
                              ? "—"
                              : formatUsd(e.pricePerUnit, locale)}
                          </td>
                          <td className="px-3 py-1 text-right tabular-nums text-muted-foreground/70">
                            {e.marketPriceAtOp != null
                              ? formatUsd(e.marketPriceAtOp, locale)
                              : "—"}
                          </td>
                          <td className="px-3 py-1 text-right tabular-nums font-medium">
                            {e.costSource === "unknown" ||
                            (e.costSource === "cex" && e.costUsd === 0)
                              ? "—"
                              : formatUsd(e.costUsd, locale)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <div className="px-3 py-3 text-xs text-muted-foreground">
                  Нет событий с известным cost basis: ни on-chain покупок,
                  ни CEX-withdrawal с matched tx-hash, ни LP-unwind. Все
                  токены пришли как transfer_in без атрибуции.
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

              {/* Per-symbol summary.
                  UCB C4: footer = sum of line-items (lotCb.totalCostUsd).
                  Раньше использовался coverage.coveredUsd + ... — другой
                  движок → расхождение с line items. Теперь by-construction
                  line-sum == footer. Amount показываем supplied (не live),
                  чтобы yield не «прибавлялся» к cost basis. */}
              {sym.lotCb.totalCostUsd > 0 && (
                <div className="border-t border-border/60 bg-secondary/20 px-3 py-2 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      {formatNumber(sym.lotCb.totalAmountSupplied, locale, 6)}{" "}
                      {sym.symbol} ×{" "}
                      {formatUsd(sym.lotCb.effectiveWac, locale)} (
                      {lotMethodology})
                    </span>
                    <span className="font-bold tabular-nums">
                      = {formatUsd(sym.lotCb.totalCostUsd, locale)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* UCB B7: footer теперь показывает ТОЛЬКО реальные траты.
            Раньше было 2 цифры (extrapolation + honest) — сбивало юзера. */}
        <div className="shrink-0 rounded-md border border-brand-cyan/30 bg-brand-cyan/5 px-3 py-2 text-xs">
          <div className="flex justify-between py-0.5">
            <span className="text-muted-foreground">
              Стартовая $ (в таблице)
            </span>
            <span className="font-mono font-bold tabular-nums">
              {formatUsd(startUsdShown, locale)}
            </span>
          </div>
          <div className="flex justify-between py-0.5 border-t border-border/40 pt-1.5">
            <span className="text-foreground font-medium">
              Реально потрачено $ на актив
              {overallCoverage < 95 && (
                <span className="ml-1 text-warning">
                  (покрытие {overallCoverage.toFixed(0)}%)
                </span>
              )}
            </span>
            <span
              className={`font-mono font-bold tabular-nums ${
                overallCoverage < 95 ? "text-warning" : "text-success"
              }`}
            >
              {formatUsd(totalHonestSpent, locale)}
            </span>
          </div>
          {overallCoverage < 95 && (
            <div className="flex justify-between py-0.5 text-[11px] text-muted-foreground">
              <span>
                + extrapolation для unattributed amount (WAC × {(100 - overallCoverage).toFixed(0)}%)
              </span>
              <span className="font-mono tabular-nums">
                {formatUsd(totalWacBased - totalHonestSpent, locale)}
              </span>
            </div>
          )}
          {/* Breakdown по источникам — показываем только если есть
              inheritance, иначе скрываем чтобы не шуметь. */}
          {(totalCexInheritedUsd > 0 || totalLpInheritedUsd > 0) && (
            <div className="mt-1 space-y-0.5 border-t border-border/40 pt-1 text-[11px] text-muted-foreground">
              {totalCexInheritedUsd > 0 && (
                <div className="flex justify-between">
                  <span>↳ Из CEX (P2P→trade→withdrawal)</span>
                  <span className="tabular-nums text-success">
                    {formatUsd(totalCexInheritedUsd, locale)}
                  </span>
                </div>
              )}
              {totalLpInheritedUsd > 0 && (
                <div className="flex justify-between">
                  <span>↳ Из закрытых LP (inherited)</span>
                  <span className="tabular-nums text-violet-400">
                    {formatUsd(totalLpInheritedUsd, locale)}
                  </span>
                </div>
              )}
            </div>
          )}
          {overallCoverage < 95 && totalCovered > 0 && (
            <p className="mt-1.5 border-t border-warning/30 pt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              ⚠️ Только{" "}
              <strong className="text-warning">
                {overallCoverage.toFixed(1)}%
              </strong>{" "}
              underlying токенов в позиции имеют известный cost basis (direct
              buy + CEX-withdrawal + LP-unwind). Остальное — transfer_in без
              атрибуции (внутренние переводы / airdrops). «Стартовая $» по
              WAC экстраполирует cost basis на ВСЁ кол-во — это приближение.
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
