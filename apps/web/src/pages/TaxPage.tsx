/**
 * Tax T3: tax-export page (`/tax`).
 *
 * Reads ops через `loadedById`, для каждого wallet'а генерит TaxEvent[]
 * через `generateTaxEvents` (per-lot detail), показывает summary +
 * filterable table + CSV download button.
 *
 * Year filter — по `disposedAt`. Type filter — sale / exchange / income.
 *
 * v1 limits:
 *   - Только on-chain ops (CEX-side trades / P2P sales — backlog T4).
 *   - WAC методология (FIFO/LIFO/HIFO selector — backlog T1.1).
 *   - Без jurisdiction-specific правил (US-style holding period; EU/RU
 *     поведенческие особенности — backlog T5).
 */
import { useMemo, useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useLoadedWallets } from "@/components/data/LoadedWalletsProvider";
import { useCexTaxEvents } from "@/features/cex/hooks";
import { applyAnnotationsToOps } from "@/lib/portfolio/apply_annotations";
import {
  exportTaxEventsToCsv,
  summarizeTaxEvents,
} from "@/lib/portfolio/tax_csv";
import {
  generateTaxEvents,
  type TaxEvent,
  type TaxEventType,
} from "@/lib/portfolio/tax_events";
import type { LotMethodology } from "@/lib/portfolio/lots/types";
import {
  JURISDICTIONS,
  getJurisdictionConfig,
  getDefaultMethodForJurisdiction,
  type Jurisdiction,
} from "@/lib/portfolio/tax_jurisdictions";

function formatUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs < 0.01) return "$0.00";
  return n.toLocaleString("ru-RU", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function formatAmount(n: number): string {
  if (n < 0.001) return n.toFixed(6);
  if (n < 1) return n.toFixed(4);
  if (n < 1000) return n.toFixed(3);
  return n.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
}

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("ru-RU", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function pnlColor(n: number): string {
  if (n > 0) return "text-emerald-400";
  if (n < 0) return "text-destructive";
  return "text-muted-foreground";
}

const EVENT_TYPE_COLOR: Record<TaxEventType, string> = {
  sale: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  exchange: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  income: "bg-amber-500/15 text-amber-300 border-amber-500/30",
};

const PAGE_SIZE = 200;

function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function TaxPage(): JSX.Element {
  const { loadedById, annotationsByKey } = useLoadedWallets();
  const cexTaxQ = useCexTaxEvents();
  const [filterYear, setFilterYear] = useState<string>("");
  const [filterType, setFilterType] = useState<string>("");
  const [jurisdiction, setJurisdiction] = useState<Jurisdiction>("US");
  const [method, setMethod] = useState<LotMethodology>("WAC");
  const [includeCexEvents, setIncludeCexEvents] = useState<boolean>(true);
  const [limit, setLimit] = useState<number>(PAGE_SIZE);

  // T5: при смене jurisdiction авто-set method на её default (если current
  // не в whitelist'е).
  const config = getJurisdictionConfig(jurisdiction);
  const methodAllowed = config.allowedMethodologies.includes(method);
  const effectiveMethod: LotMethodology = methodAllowed
    ? method
    : getDefaultMethodForJurisdiction(jurisdiction);

  // ─── generate tax events ─────────────────────────────────────────────
  const allEvents = useMemo<TaxEvent[]>(() => {
    const events: TaxEvent[] = [];
    for (const l of Object.values(loadedById)) {
      const realWalletId = l.wallet.id.startsWith("api:")
        ? (l.wallet.id.split(":")[1] ?? l.wallet.id)
        : l.wallet.id;
      // Apply annotations (D8 excluded, manual op_type) before tax gen.
      const effectiveOps = applyAnnotationsToOps(
        l.ops,
        realWalletId,
        annotationsByKey,
      );
      const perWallet = generateTaxEvents(
        effectiveOps,
        realWalletId,
        effectiveMethod,
        jurisdiction,
      );
      events.push(...perWallet);
    }
    // Tax T4: merge CEX-side tax events (P2P sales + trade gains).
    // CEX events приходят с server-side WAC pool — methodology selector
    // их не влияет в v1 (backlog T4.1).
    if (includeCexEvents && cexTaxQ.data?.events) {
      for (const c of cexTaxQ.data.events) {
        const disposedTs = Math.floor(new Date(c.disposedAt).getTime() / 1000);
        const acquiredTs = Math.floor(new Date(c.acquiredAt).getTime() / 1000);
        events.push({
          disposedAt: disposedTs,
          acquiredAt: acquiredTs,
          holdingPeriodDays: c.holdingPeriodDays,
          term: c.term,
          eventType: c.eventType,
          asset: c.asset,
          assetFamily: c.assetFamily,
          amount: c.amount,
          proceedsUsd: c.proceedsUsd,
          costBasisUsd: c.costBasisUsd,
          gainUsd: c.gainUsd,
          // Synthetic CEX-side identifiers — нет on-chain txHash.
          txHash: `cex:${c.exchange}:${c.source}:${c.sourceId}`,
          chain: c.exchange,
          sourceHash: c.sourceId,
          walletId: c.cexAccountId,
        });
      }
    }
    return events.sort((a, b) => b.disposedAt - a.disposedAt);
  }, [
    loadedById,
    annotationsByKey,
    effectiveMethod,
    jurisdiction,
    includeCexEvents,
    cexTaxQ.data,
  ]);

  // ─── filters ─────────────────────────────────────────────────────────
  const uniqueYears = useMemo(() => {
    const s = new Set<string>();
    for (const e of allEvents) {
      s.add(String(new Date(e.disposedAt * 1000).getUTCFullYear()));
    }
    return [...s].sort((a, b) => Number(b) - Number(a));
  }, [allEvents]);

  const filtered = useMemo<TaxEvent[]>(() => {
    return allEvents.filter((e) => {
      if (filterYear) {
        const y = String(new Date(e.disposedAt * 1000).getUTCFullYear());
        if (y !== filterYear) return false;
      }
      if (filterType && e.eventType !== filterType) return false;
      return true;
    });
  }, [allEvents, filterYear, filterType]);

  const summary = useMemo(() => summarizeTaxEvents(filtered), [filtered]);

  const visible = filtered.slice(0, limit);
  const hasMore = filtered.length > limit;

  const handleDownload = (): void => {
    const csv = exportTaxEventsToCsv(filtered);
    const year = filterYear || "all";
    const ts = new Date().toISOString().slice(0, 10);
    downloadCsv(
      `capflow-tax-${jurisdiction}-${effectiveMethod.toLowerCase()}-${year}-${ts}.csv`,
      csv,
    );
  };

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tax export</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Per-disposition tax events для отчётности. Каждая sale / token-to-token
            exchange / reward (income) — отдельное событие с cost basis из
            UCB pipeline. WAC методология. US-style holding period (≥365d = long
            term). CSV экспортируется в формат, совместимый с Koinly /
            CoinTracker import.
          </p>
        </div>
        <Button
          onClick={handleDownload}
          disabled={filtered.length === 0}
          variant="default"
        >
          Download CSV ({filtered.length})
        </Button>
      </div>

      {/* ─── Summary cards ───────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Card>
          <CardContent className="p-4">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Events
            </div>
            <div className="mt-1 text-xl font-semibold tabular-nums">
              {summary.totalEvents.toLocaleString("ru-RU")}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div
              className="text-[10px] uppercase tracking-wider text-muted-foreground"
              title="Holdings sold < 365 days after acquisition. US: taxed as ordinary income."
            >
              Short-term gain
            </div>
            <div
              className={
                "mt-1 text-xl font-semibold tabular-nums " +
                pnlColor(summary.shortTermGain)
              }
            >
              {summary.shortTermGain >= 0 ? "+" : ""}
              {formatUsd(summary.shortTermGain)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div
              className="text-[10px] uppercase tracking-wider text-muted-foreground"
              title="Holdings sold ≥ 365 days after acquisition. US: capital gains rate."
            >
              Long-term gain
            </div>
            <div
              className={
                "mt-1 text-xl font-semibold tabular-nums " +
                pnlColor(summary.longTermGain)
              }
            >
              {summary.longTermGain >= 0 ? "+" : ""}
              {formatUsd(summary.longTermGain)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div
              className="text-[10px] uppercase tracking-wider text-muted-foreground"
              title="UCB D6: FMV at receipt of rewards. US: ordinary income at receipt."
            >
              Income (rewards)
            </div>
            <div className="mt-1 text-xl font-semibold tabular-nums text-amber-400">
              {formatUsd(summary.incomeUsd)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Proceeds
            </div>
            <div className="mt-1 text-xl font-semibold tabular-nums">
              {formatUsd(summary.totalProceeds)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Cost basis
            </div>
            <div className="mt-1 text-xl font-semibold tabular-nums">
              {formatUsd(summary.totalCostBasis)}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ─── Filters ─────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-4 flex flex-wrap gap-3 items-end">
          <div className="min-w-[160px]">
            <label
              className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1"
              title="Jurisdiction-specific rules: long-term threshold, allowed methodologies, token-to-token treatment."
            >
              Jurisdiction (T5)
            </label>
            <select
              value={jurisdiction}
              onChange={(e) =>
                setJurisdiction(e.target.value as Jurisdiction)
              }
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs"
            >
              {JURISDICTIONS.map((j) => (
                <option key={j} value={j}>
                  {getJurisdictionConfig(j).label}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-[200px]">
            <label
              className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1"
              title="Lot consume methodology — определяет какие лоты потребляются при sale. HIFO = tax-optimal."
            >
              Lot method (T1.1)
              {!methodAllowed && (
                <span className="ml-1 text-amber-400" title={`Reset to ${effectiveMethod} (allowed in ${jurisdiction})`}>
                  ⚠
                </span>
              )}
            </label>
            <select
              value={effectiveMethod}
              onChange={(e) => setMethod(e.target.value as LotMethodology)}
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs"
            >
              {config.allowedMethodologies.map((m) => (
                <option key={m} value={m}>
                  {m === "WAC"
                    ? "WAC — weighted average"
                    : m === "FIFO"
                      ? "FIFO — first-in-first-out"
                      : m === "LIFO"
                        ? "LIFO — last-in-first-out"
                        : "HIFO — highest cost (tax-optimal)"}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-[140px]">
            <label className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              Tax year
            </label>
            <select
              value={filterYear}
              onChange={(e) => setFilterYear(e.target.value)}
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs"
            >
              <option value="">All years</option>
              {uniqueYears.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-[140px]">
            <label className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              Event type
            </label>
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs"
            >
              <option value="">All types</option>
              <option value="sale">Sale</option>
              <option value="exchange">Exchange (token-to-token)</option>
              <option value="income">Income (rewards)</option>
            </select>
          </div>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer pb-1">
            <input
              type="checkbox"
              checked={includeCexEvents}
              onChange={(e) => setIncludeCexEvents(e.target.checked)}
              className="accent-brand-cyan"
            />
            <span title="Tax T4: include CEX-side P2P sales и trade gains">
              Включить CEX events (T4)
              {cexTaxQ.data?.events && (
                <span className="ml-1 text-muted-foreground">
                  ({cexTaxQ.data.events.length})
                </span>
              )}
            </span>
          </label>
        </CardContent>
      </Card>

      {/* ─── Events table ────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Tax events ({visible.length}/{filtered.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {/* Desktop: таблица */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-y border-border bg-secondary/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium w-28">
                    Disposed
                  </th>
                  <th className="px-3 py-2 text-left font-medium w-24">Type</th>
                  <th className="px-3 py-2 text-left font-medium w-20">Asset</th>
                  <th className="px-3 py-2 text-right font-medium w-24">
                    Amount
                  </th>
                  <th className="px-3 py-2 text-right font-medium w-24">
                    Proceeds
                  </th>
                  <th className="px-3 py-2 text-right font-medium w-24">Cost</th>
                  <th className="px-3 py-2 text-right font-medium w-24">Gain</th>
                  <th className="px-3 py-2 text-left font-medium w-20">Term</th>
                  <th className="px-3 py-2 text-left font-medium w-32">Tx</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visible.length === 0 ? (
                  <tr>
                    <td
                      colSpan={9}
                      className="px-3 py-12 text-center text-muted-foreground"
                    >
                      {allEvents.length === 0
                        ? "Нет tax events. Подключи кошельки в Registry."
                        : "Нет events по выбранным фильтрам."}
                    </td>
                  </tr>
                ) : (
                  visible.map((e, idx) => (
                    <tr
                      key={`${e.txHash}:${idx}:${e.acquiredAt}`}
                      className="hover:bg-accent/30"
                    >
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">
                        {formatDate(e.disposedAt)}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={
                            "inline-block rounded border px-1.5 py-0.5 text-[10px] " +
                            EVENT_TYPE_COLOR[e.eventType]
                          }
                        >
                          {e.eventType}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-medium">{e.asset}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatAmount(e.amount)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatUsd(e.proceedsUsd)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {formatUsd(e.costBasisUsd)}
                      </td>
                      <td
                        className={
                          "px-3 py-2 text-right tabular-nums " +
                          pnlColor(e.gainUsd)
                        }
                      >
                        {e.gainUsd >= 0 ? "+" : ""}
                        {formatUsd(e.gainUsd)}
                      </td>
                      <td className="px-3 py-2">
                        <Badge
                          variant="outline"
                          className={
                            "text-[9px] uppercase " +
                            (e.term === "long"
                              ? "border-emerald-500/30 text-emerald-300"
                              : "border-amber-500/30 text-amber-300")
                          }
                          title={`${e.holdingPeriodDays} days holding`}
                        >
                          {e.term} ({e.holdingPeriodDays}d)
                        </Badge>
                      </td>
                      <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground">
                        {e.txHash.slice(0, 8)}…{e.txHash.slice(-4)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Mobile: карточки */}
          <ul className="md:hidden divide-y divide-border border-y border-border">
            {visible.length === 0 ? (
              <li className="px-4 py-12 text-center text-xs text-muted-foreground">
                {allEvents.length === 0
                  ? "Нет tax events. Подключи кошельки в Registry."
                  : "Нет events по выбранным фильтрам."}
              </li>
            ) : (
              visible.map((e, idx) => (
                <li key={`${e.txHash}:${idx}:${e.acquiredAt}`} className="px-4 py-3 text-xs">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                      <span
                        className={
                          "inline-block rounded border px-1.5 py-0.5 text-[10px] " +
                          EVENT_TYPE_COLOR[e.eventType]
                        }
                      >
                        {e.eventType}
                      </span>
                      <span className="font-medium text-sm">{e.asset}</span>
                      <Badge
                        variant="outline"
                        className={
                          "text-[9px] uppercase " +
                          (e.term === "long"
                            ? "border-emerald-500/30 text-emerald-300"
                            : "border-amber-500/30 text-amber-300")
                        }
                      >
                        {e.term} ({e.holdingPeriodDays}d)
                      </Badge>
                    </div>
                    <div className={"text-right tabular-nums font-semibold shrink-0 " + pnlColor(e.gainUsd)}>
                      {e.gainUsd >= 0 ? "+" : ""}
                      {formatUsd(e.gainUsd)}
                    </div>
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground tabular-nums">
                    {formatDate(e.disposedAt)}
                  </div>
                  <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">Amount</dt>
                      <dd className="tabular-nums">{formatAmount(e.amount)}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">Proceeds</dt>
                      <dd className="tabular-nums">{formatUsd(e.proceedsUsd)}</dd>
                    </div>
                    <div className="flex justify-between gap-2 col-span-2">
                      <dt className="text-muted-foreground">Cost</dt>
                      <dd className="tabular-nums text-muted-foreground">{formatUsd(e.costBasisUsd)}</dd>
                    </div>
                  </dl>
                  <div className="mt-1 font-mono text-[10px] text-muted-foreground/70">
                    {e.txHash.slice(0, 8)}…{e.txHash.slice(-4)}
                  </div>
                </li>
              ))
            )}
          </ul>

          {hasMore && (
            <div className="border-t border-border p-3 text-center">
              <button
                type="button"
                onClick={() => setLimit(limit + PAGE_SIZE)}
                className="text-xs text-brand-cyan hover:underline"
              >
                Показать ещё {Math.min(PAGE_SIZE, filtered.length - limit)} events
              </button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── Jurisdiction notes ───────────────────────────────────────── */}
      <Card>
        <CardContent className="p-4 text-xs text-muted-foreground space-y-2">
          <p className="font-medium text-foreground">
            {config.label} ({jurisdiction}) — методологические заметки
          </p>
          <p>{config.notes}</p>
          <p className="text-[10px]">
            ⚠ Software model — не legal advice. Для filing проконсультируйся
            с tax advisor.
          </p>
        </CardContent>
      </Card>

      {/* ─── Methodology note ────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-4 text-xs text-muted-foreground space-y-2">
          <p className="font-medium text-foreground">Methodology</p>
          <ul className="list-disc pl-4 space-y-1">
            <li>
              <strong>Sale</strong>: non-stable → stable swap, withdraw_fiat.
              Реализация capital gain/loss.
            </li>
            <li>
              <strong>Exchange</strong>: token-to-token swap (e.g. ETH→BTC). С
              2018 в US это taxable event (нет "like-kind" exception).
            </li>
            <li>
              <strong>Income</strong>: reward / staking / yield (UCB D6).
              FMV at receipt = ordinary income. Cost basis = $0.
            </li>
            <li>
              <strong>Term (T5)</strong>: threshold зависит от jurisdiction.
              US/EU = 365d, RU = 1095d (3 года), UK = no distinction (всегда
              "short" в нашей model — UK Section 104 pooling).
            </li>
            <li>
              <strong>Lot method (T1.1)</strong>: WAC / FIFO / LIFO / HIFO. HIFO
              (highest-cost-first) — tax-optimal: минимизирует gain. В US Specific
              ID разрешён для crypto; в RU / EU — обычно FIFO/LIFO.
            </li>
            <li>
              <strong>Annotations honored</strong>: UCB D8 excluded ops
              отфильтрованы; A3/A4 manual op_type / cost basis применены.
            </li>
            <li>
              <strong>CEX-side (T4)</strong>: P2P sales + trade dispositions
              приходят с server `CexTaxEventsService` (WAC pool). Включаются
              через toggle "Включить CEX events". txHash в CSV для них:{" "}
              <code>cex:&lt;exchange&gt;:&lt;source&gt;:&lt;id&gt;</code>.
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
