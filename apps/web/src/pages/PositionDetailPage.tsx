/**
 * UCB E2: standalone position breakdown page.
 *
 * Cost basis приходит через `useComputedPositions()` — тот же
 * post-override список, что у /positions. Раньше эта страница вызывала
 * `buildOpenPositions` инлайн без V3/Lending/CEX overrides → один и тот же
 * `position.id` показывал разные `startUsd` в листе и в детальной. См. UCB
 * principle #2 (single source of truth).
 */
import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLoadedWallets } from "@/components/data/LoadedWalletsProvider";
import type { AcquiredVia, Lot } from "@/lib/portfolio/lots";
import type { OpenPosition } from "@/lib/portfolio/open_positions";
import { useComputedPositions } from "@/lib/portfolio/use_computed_positions";

function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs < 0.01) return "$0.00";
  if (abs < 1) return `$${n.toFixed(4)}`;
  return n.toLocaleString("ru-RU", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function formatPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function formatAmount(n: number): string {
  if (n < 0.01) return n.toFixed(6);
  if (n < 1) return n.toFixed(4);
  if (n < 1000) return n.toFixed(3);
  return n.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
}

function formatDate(ts: number | null): string {
  if (ts == null) return "—";
  return new Date(ts * 1000).toLocaleDateString("ru-RU", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function pnlColor(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "text-muted-foreground";
  if (n > 0) return "text-emerald-400";
  if (n < 0) return "text-destructive";
  return "text-muted-foreground";
}

// ─── UCB C4: provenance trail labels ──────────────────────────────────

interface AcquiredViaMeta {
  label: string;
  color: string;
  tooltip: string;
}

const ACQUIRED_VIA_META: Record<AcquiredVia, AcquiredViaMeta> = {
  buy_with_stable: {
    label: "Buy",
    color: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
    tooltip: "Swap: потратил stable → получил токен. Cost = stable amount.",
  },
  swap: {
    label: "Swap",
    color: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
    tooltip:
      "Token-to-token swap. Cost basis перенесён из consumed lot'а другого токена.",
  },
  transfer_in: {
    label: "Transfer in",
    color: "bg-amber-500/20 text-amber-400 border-amber-500/30",
    tooltip:
      "Transfer от внешнего источника. Cost = market price (или manual / CEX-inherited).",
  },
  claim_rewards: {
    label: "Reward (legacy)",
    color: "bg-orange-500/20 text-orange-400 border-orange-500/30",
    tooltip:
      "Legacy reward acquisition с market-price cost (до UCB D6). После D6 — `received_as_reward`.",
  },
  received_as_reward: {
    label: "Reward",
    color: "bg-amber-400/20 text-amber-300 border-amber-400/30",
    tooltip:
      "UCB D6: yield / staking / LP reward. Cost basis = $0; sale = full proceeds realized.",
  },
  airdrop: {
    label: "Airdrop",
    color: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
    tooltip: "Airdrop. Cost basis = $0 по умолчанию.",
  },
  lp_close: {
    label: "LP close",
    color: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
    tooltip:
      "Выход из LP. Cost basis вернулся из закрытой позиции в виде токенов.",
  },
  lend_withdraw: {
    label: "Lend withdraw",
    color: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
    tooltip:
      "Withdraw из lending с накопленным yield. Cost basis = принципал + начисленный доход.",
  },
  borrow: {
    label: "Borrow (debt)",
    color: "bg-red-500/20 text-red-400 border-red-500/30",
    tooltip:
      "Borrowed funds. Cost basis = 0, но создан долг (не free money).",
  },
  manual_seed: {
    label: "Manual seed",
    color: "bg-purple-500/20 text-purple-400 border-purple-500/30",
    tooltip:
      "Ручная разметка стартового капитала пользователем (manual annotation).",
  },
  linked_async_fill: {
    label: "Async fill",
    color: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
    tooltip: "Async deposit fill — cost из linked initiator-tx.",
  },
  bridge_in: {
    label: "Bridge",
    color: "bg-purple-500/20 text-purple-400 border-purple-500/30",
    tooltip:
      "UCB D5: cross-chain bridge. Cost basis сохранён через `lastBridgeOutWac` state из паритетного bridge_out.",
  },
};

function shortHash(h: string): string {
  if (!h || h.length < 12) return h;
  if (h.startsWith("rebase:")) return h;
  return `${h.slice(0, 6)}…${h.slice(-4)}`;
}

interface LotSummaryRow {
  via: AcquiredVia;
  count: number;
  totalAmount: number;
  totalCostUsd: number;
}

function summarizeLotsByVia(lots: readonly Lot[]): LotSummaryRow[] {
  const map = new Map<AcquiredVia, LotSummaryRow>();
  for (const lot of lots) {
    const cur = map.get(lot.acquiredVia) ?? {
      via: lot.acquiredVia,
      count: 0,
      totalAmount: 0,
      totalCostUsd: 0,
    };
    cur.count += 1;
    cur.totalAmount += lot.amount;
    cur.totalCostUsd += lot.amount * lot.costPerUnitUsd;
    map.set(lot.acquiredVia, cur);
  }
  return [...map.values()].sort((a, b) => b.totalCostUsd - a.totalCostUsd);
}

interface KpiCardProps {
  label: string;
  value: string;
  subtitle?: string;
  valueClass?: string;
  tooltip?: string;
}

function KpiCard({ label, value, subtitle, valueClass, tooltip }: KpiCardProps): JSX.Element {
  return (
    <Card>
      <CardContent className="p-4">
        <div
          className="text-xs uppercase tracking-wider text-muted-foreground"
          title={tooltip}
        >
          {label}
        </div>
        <div
          className={
            "mt-1 text-2xl font-semibold tabular-nums " + (valueClass ?? "")
          }
        >
          {value}
        </div>
        {subtitle && (
          <div className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
            {subtitle}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function PositionDetailPage(): JSX.Element {
  const { positionId } = useParams<{ positionId: string }>();
  const { newTrackers } = useLoadedWallets();
  const { positions } = useComputedPositions();

  const position = useMemo<OpenPosition | null>(
    () => (positionId ? positions.find((p) => p.id === positionId) ?? null : null),
    [positions, positionId],
  );

  if (!positionId) {
    return (
      <div className="space-y-6 p-6">
        <p className="text-sm text-muted-foreground">
          Не указан ID позиции.{" "}
          <Link to="/performance" className="text-brand-cyan hover:underline">
            Назад к Performance
          </Link>
        </p>
      </div>
    );
  }

  if (!position) {
    return (
      <div className="space-y-6 p-6">
        <Link to="/performance" className="text-sm text-brand-cyan hover:underline">
          ← Назад к Performance
        </Link>
        <Card>
          <CardContent className="space-y-3 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              Позиция <span className="font-mono">{positionId}</span> не найдена.
            </p>
            <p className="text-xs text-muted-foreground">
              Возможно, она была закрыта или относится к не загруженному
              сейчас кошельку. Открой Registry и подгрузи нужный wallet.
            </p>
            <Button asChild variant="outline" size="sm">
              <Link to="/performance">К списку позиций</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ─── derived metrics ────────────────────────────────────────────────
  const unrealizedUsd = position.currentUsd - position.startUsd;
  const unrealizedPct =
    position.startUsd > 0 ? (unrealizedUsd / position.startUsd) * 100 : null;
  const netUnrealizedUsd =
    position.netStartUsd > 0 ? position.currentUsd - position.netStartUsd : null;
  const hasLeverage =
    position.netStartUsd > 0 &&
    position.startUsd > 0 &&
    position.netStartUsd / position.startUsd < 0.95;
  const leverage =
    hasLeverage && position.netStartUsd > 0
      ? position.startUsd / position.netStartUsd
      : null;

  return (
    <div className="space-y-6 p-6">
      {/* ─── Header ───────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            to="/performance"
            className="text-xs text-brand-cyan hover:underline"
          >
            ← Performance
          </Link>
          <div className="mt-1 flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {position.protocol.name}
            </h1>
            <Badge variant="outline" className="text-[10px] uppercase">
              {position.chain}
            </Badge>
            <Badge variant="secondary" className="text-[10px]">
              {position.kind}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {position.itemName} · {position.walletName}
            {position.ageDays != null && (
              <>
                {" · "}
                <span title={`Открыта ${formatDate(position.openedAt)}`}>
                  {Math.floor(position.ageDays)}d age
                </span>
              </>
            )}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Position ID
          </span>
          <span className="font-mono text-xs">{position.id}</span>
        </div>
      </div>

      {/* ─── KPI strip ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Cost basis"
          value={formatUsd(position.startUsd)}
          subtitle={
            hasLeverage && leverage
              ? `Net: ${formatUsd(position.netStartUsd)} · ${leverage.toFixed(1)}× leverage`
              : undefined
          }
          tooltip="Σ supplyTokens.startUsd — суммарная cost basis открытия позиции (gross collateral cost)"
        />
        <KpiCard
          label="Current value"
          value={formatUsd(position.currentUsd)}
          subtitle={
            position.currentDebtUsd > 0
              ? `Debt: ${formatUsd(position.currentDebtUsd)}`
              : undefined
          }
        />
        <KpiCard
          label="Unrealized PnL"
          value={`${unrealizedUsd >= 0 ? "+" : ""}${formatUsd(unrealizedUsd)}`}
          subtitle={unrealizedPct != null ? formatPct(unrealizedPct) : undefined}
          valueClass={pnlColor(unrealizedUsd)}
          tooltip={
            netUnrealizedUsd != null
              ? `Net (без borrow): ${netUnrealizedUsd >= 0 ? "+" : ""}${formatUsd(netUnrealizedUsd)}`
              : undefined
          }
        />
        <KpiCard
          label="Fees lifetime"
          value={formatUsd(position.feesLifetimeUsd)}
          subtitle={
            position.feeAprLifetime != null
              ? `${formatPct(position.feeAprLifetime)} APR`
              : undefined
          }
          tooltip="Pending + claimed fees за всё время жизни позиции"
        />
      </div>

      {/* ─── Supply tokens ───────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Supply ({position.supplyTokens.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <div className="overflow-x-auto">
            <table className="w-full text-xs" style={{ minWidth: 600 }}>
              <thead className="border-y border-border bg-secondary/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Token</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                  <th className="px-3 py-2 text-right font-medium">Avg buy</th>
                  <th className="px-3 py-2 text-right font-medium">Cost basis</th>
                  <th className="px-3 py-2 text-right font-medium">Current</th>
                  <th className="px-3 py-2 text-right font-medium">Unrealized</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {position.supplyTokens.map((t) => {
                  const tokenPnl = t.currentUsd - t.startUsd;
                  return (
                    <tr key={t.symbol} className="hover:bg-accent/40">
                      <td className="px-3 py-2 font-medium">{t.symbol}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatAmount(t.amount)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {t.avgBuyPrice ? formatUsd(t.avgBuyPrice) : "—"}
                      </td>
                      <td
                        className="px-3 py-2 text-right tabular-nums"
                        title={`Price source: ${t.priceSource}`}
                      >
                        {formatUsd(t.startUsd)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatUsd(t.currentUsd)}
                      </td>
                      <td
                        className={
                          "px-3 py-2 text-right tabular-nums " + pnlColor(tokenPnl)
                        }
                      >
                        {tokenPnl >= 0 ? "+" : ""}
                        {formatUsd(tokenPnl)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* ─── UCB C4: cost basis provenance trail ─────────────────────── */}
      {(() => {
        const tracker = newTrackers.lotsByWallet.get(position.walletId);
        if (!tracker) return null;
        const perToken = position.supplyTokens
          .map((t) => ({
            token: t,
            lots: tracker.getLots(position.walletId, t.symbol),
          }))
          .filter((x) => x.lots.length > 0);
        if (perToken.length === 0) return null;

        return (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Cost basis provenance
                <span className="ml-2 text-[10px] uppercase text-muted-foreground">
                  · UCB C4
                </span>
              </CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                Откуда пришёл cost basis каждого supply-токена. Сгруппировано
                по `acquiredVia` (Buy / Swap / Transfer / Reward / Bridge / …).
                Кликни лот чтобы увидеть source tx hash.
              </p>
            </CardHeader>
            <CardContent className="space-y-5">
              {perToken.map(({ token, lots }) => {
                const summary = summarizeLotsByVia(lots);
                const totalCost = summary.reduce(
                  (s, r) => s + r.totalCostUsd,
                  0,
                );
                return (
                  <div key={token.symbol} className="space-y-2">
                    <div className="flex items-baseline justify-between">
                      <span className="text-sm font-semibold">
                        {token.symbol}
                      </span>
                      <span className="text-[11px] text-muted-foreground tabular-nums">
                        {lots.length} lot{lots.length === 1 ? "" : "s"} ·{" "}
                        {formatUsd(totalCost)} total cost
                      </span>
                    </div>
                    {/* Summary by acquiredVia */}
                    <div className="flex flex-wrap gap-2">
                      {summary.map((s) => {
                        const meta = ACQUIRED_VIA_META[s.via];
                        const pct =
                          totalCost > 0 ? (s.totalCostUsd / totalCost) * 100 : 0;
                        return (
                          <div
                            key={s.via}
                            className={
                              "rounded border px-2 py-1 text-[10px] " + meta.color
                            }
                            title={meta.tooltip}
                          >
                            <span className="font-medium">{meta.label}</span>
                            <span className="mx-1 opacity-60">·</span>
                            <span className="tabular-nums">
                              {formatUsd(s.totalCostUsd)}
                            </span>
                            <span className="ml-1 opacity-60 tabular-nums">
                              ({pct.toFixed(0)}%)
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    {/* Detailed lot table */}
                    <div className="overflow-x-auto rounded border border-border">
                      <table className="w-full text-[11px]" style={{ minWidth: 700 }}>
                        <thead className="bg-secondary/40 text-[9px] uppercase tracking-wider text-muted-foreground">
                          <tr>
                            <th className="px-2 py-1.5 text-left font-medium">Date</th>
                            <th className="px-2 py-1.5 text-left font-medium">Source</th>
                            <th className="px-2 py-1.5 text-right font-medium">Amount</th>
                            <th className="px-2 py-1.5 text-right font-medium">Cost / unit</th>
                            <th className="px-2 py-1.5 text-right font-medium">Total cost</th>
                            <th className="px-2 py-1.5 text-left font-medium">Tx</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {lots.map((lot, idx) => {
                            const meta = ACQUIRED_VIA_META[lot.acquiredVia];
                            const total = lot.amount * lot.costPerUnitUsd;
                            return (
                              <tr
                                key={`${lot.sourceHash}-${idx}`}
                                className="hover:bg-accent/30"
                              >
                                <td className="px-2 py-1.5 tabular-nums text-muted-foreground">
                                  {formatDate(lot.acquiredAt)}
                                </td>
                                <td className="px-2 py-1.5">
                                  <span
                                    className={
                                      "inline-block rounded border px-1.5 py-0.5 text-[9px] " +
                                      meta.color
                                    }
                                    title={meta.tooltip}
                                  >
                                    {meta.label}
                                  </span>
                                </td>
                                <td className="px-2 py-1.5 text-right tabular-nums">
                                  {formatAmount(lot.amount)}
                                </td>
                                <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                                  {lot.costPerUnitUsd > 0
                                    ? formatUsd(lot.costPerUnitUsd)
                                    : "—"}
                                </td>
                                <td className="px-2 py-1.5 text-right tabular-nums">
                                  {total > 0 ? formatUsd(total) : "—"}
                                  {lot.fmvAtAcquisitionUsd != null &&
                                    lot.fmvAtAcquisitionUsd > 0 && (
                                      <span
                                        className="ml-1 text-[9px] text-amber-400"
                                        title={`FMV at receipt (UCB D6): ${formatUsd(lot.fmvAtAcquisitionUsd)}`}
                                      >
                                        FMV
                                      </span>
                                    )}
                                </td>
                                <td className="px-2 py-1.5 font-mono text-[10px] text-muted-foreground">
                                  {shortHash(lot.sourceHash)}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        );
      })()}

      {/* ─── Debt tokens (lending) ───────────────────────────────────── */}
      {position.debtTokens.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-3">
              <span>Borrow ({position.debtTokens.length})</span>
              {position.healthRate != null && (
                <Badge
                  variant={position.healthRate < 1.5 ? "destructive" : "outline"}
                  className="text-[10px]"
                >
                  Health: {position.healthRate.toFixed(2)}
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <div className="overflow-x-auto">
              <table className="w-full text-xs" style={{ minWidth: 400 }}>
                <thead className="border-y border-border bg-secondary/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Token</th>
                    <th className="px-3 py-2 text-right font-medium">Amount</th>
                    <th className="px-3 py-2 text-right font-medium">Debt USD</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {position.debtTokens.map((t) => (
                    <tr key={t.symbol} className="hover:bg-accent/40">
                      <td className="px-3 py-2 font-medium">{t.symbol}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatAmount(t.amount)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-destructive">
                        {formatUsd(t.usd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ─── V3 concentrated liquidity details ───────────────────────── */}
      {position.v3 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              V3 Concentrated Liquidity
              <span className="ml-2 text-[10px] uppercase text-muted-foreground">
                · {position.v3.pricesSource} prices
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div>
                <div className="text-[10px] uppercase text-muted-foreground">
                  Deposit
                </div>
                <div className="mt-0.5 font-medium tabular-nums">
                  {formatUsd(position.v3.depositUsd)}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-muted-foreground">
                  HODL (counterfactual)
                </div>
                <div className="mt-0.5 font-medium tabular-nums">
                  {formatUsd(position.v3.hodlUsd)}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-muted-foreground">
                  Current LP
                </div>
                <div className="mt-0.5 font-medium tabular-nums">
                  {formatUsd(position.v3.currentLpUsd)}
                </div>
              </div>
              <div>
                <div
                  className="text-[10px] uppercase text-muted-foreground"
                  title="HODL − Current. >0 = LP отстаёт от просто-держать."
                >
                  Impermanent loss
                </div>
                <div
                  className={
                    "mt-0.5 font-medium tabular-nums " +
                    (position.v3.impermanentLossUsd > 0
                      ? "text-destructive"
                      : "text-emerald-400")
                  }
                >
                  {formatUsd(position.v3.impermanentLossUsd)}
                </div>
              </div>
            </div>
            <div className="pt-2 border-t border-border">
              <div className="flex items-baseline gap-2">
                <span className="text-xs text-muted-foreground">PnL vs deposit:</span>
                <span
                  className={
                    "text-base font-semibold tabular-nums " +
                    pnlColor(position.v3.pnlUsd)
                  }
                >
                  {position.v3.pnlUsd >= 0 ? "+" : ""}
                  {formatUsd(position.v3.pnlUsd)} ({formatPct(position.v3.pnlPct)})
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ─── Fees claimed history ────────────────────────────────────── */}
      {position.feesClaimedHistory.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Claimed fees ({position.feesClaimedHistory.length})
              <span className="ml-2 text-[10px] uppercase text-muted-foreground">
                · total {formatUsd(position.feesClaimedUsd)}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <div className="overflow-x-auto">
              <table className="w-full text-xs" style={{ minWidth: 700 }}>
                <thead className="border-y border-border bg-secondary/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Date</th>
                    <th className="px-3 py-2 text-left font-medium">Tokens</th>
                    <th className="px-3 py-2 text-right font-medium">USD</th>
                    <th className="px-3 py-2 text-right font-medium">Period APR</th>
                    <th className="px-3 py-2 text-right font-medium">PnL since prev</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {position.feesClaimedHistory.map((e) => (
                    <tr key={e.hash} className="hover:bg-accent/40">
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">
                        {formatDate(e.time)}
                      </td>
                      <td className="px-3 py-2">
                        {e.tokensReceived
                          .map((t) => `${formatAmount(t.amount)} ${t.symbol}`)
                          .join(" + ") || "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatUsd(e.usd)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {e.aprPeriod != null ? formatPct(e.aprPeriod) : "—"}
                      </td>
                      <td
                        className={
                          "px-3 py-2 text-right tabular-nums " +
                          pnlColor(e.pnlSincePrev)
                        }
                      >
                        {e.pnlSincePrev != null
                          ? `${e.pnlSincePrev >= 0 ? "+" : ""}${formatUsd(e.pnlSincePrev)}`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ─── Wallet & open-tx info ───────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Provenance</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          <div className="flex gap-3">
            <span className="w-32 text-muted-foreground uppercase tracking-wider text-[10px]">
              Wallet
            </span>
            <span>
              <Link
                to={`/wallet/${position.walletId}`}
                className="text-brand-cyan hover:underline"
              >
                {position.walletName}
              </Link>
              <span className="ml-2 text-muted-foreground">({position.walletChain})</span>
            </span>
          </div>
          <div className="flex gap-3">
            <span className="w-32 text-muted-foreground uppercase tracking-wider text-[10px]">
              Opened at
            </span>
            <span>{formatDate(position.openedAt)}</span>
          </div>
          {position.openHash && (
            <div className="flex gap-3">
              <span className="w-32 text-muted-foreground uppercase tracking-wider text-[10px]">
                Open tx
              </span>
              <span className="font-mono text-[11px] break-all">
                {position.openHash}
              </span>
            </div>
          )}
          {position.creditFundedUsd != null && (
            <div className="flex gap-3">
              <span className="w-32 text-muted-foreground uppercase tracking-wider text-[10px]">
                Credit funded
              </span>
              <span className="tabular-nums">
                {formatUsd(position.creditFundedUsd)}
              </span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
