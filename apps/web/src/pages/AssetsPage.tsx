/**
 * UCB E1: Unified asset view — "что у меня есть и сколько" per family
 * сводно по всем wallets.
 *
 * Каждая строка — token family (ETH, BTC, USDT, ...). Кликабельна:
 * раскрывает breakdown по source-ам (wallet × chain).
 */
import { useMemo, useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLoadedWallets } from "@/components/data/LoadedWalletsProvider";
import {
  buildAssetRollup,
  type AssetRollup,
} from "@/lib/portfolio/asset_rollup";
import { runUcbPipeline } from "@/lib/portfolio/ucb_pipeline";

function formatUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs < 0.01) return "$0.00";
  if (abs < 1) return `$${n.toFixed(4)}`;
  return n.toLocaleString("ru-RU", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function formatAmount(n: number): string {
  if (n < 0.01) return n.toFixed(6);
  if (n < 1) return n.toFixed(4);
  if (n < 1000) return n.toFixed(3);
  return n.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
}

function formatPct(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

export function AssetsPage(): JSX.Element {
  const {
    loadedById,
    newTrackers,
    annotationsByKey,
    costBasisOverrideByHash,
  } = useLoadedWallets();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const rollups = useMemo<AssetRollup[]>(() => {
    const inputs = Object.values(loadedById).map((l) => ({
      walletId: l.wallet.id,
      walletName: l.wallet.name,
      live: l.live,
    }));
    return buildAssetRollup(inputs, {
      lotsByWallet: newTrackers.lotsByWallet,
    });
  }, [loadedById, newTrackers]);

  // UCB C5.2/C5.3: cross-wallet UCB pipeline. Один call вместо двух
  // manual loops, гарантирует консистентность через annotations + D8
  // soft-delete + cost basis overrides. До C5.3 realized PnL и reward
  // income считались отдельно без applyAnnotations — excluded ops
  // продолжали накапливать гейн. Теперь — нет.
  const ucb = useMemo(() => {
    const inputs = Object.values(loadedById).map((l) => {
      const realWalletId = l.wallet.id.startsWith("api:")
        ? (l.wallet.id.split(":")[1] ?? l.wallet.id)
        : l.wallet.id;
      return {
        walletId: realWalletId,
        ops: l.ops,
        annotationsByKey,
        costBasisOverrideByHash,
      };
    });
    return runUcbPipeline(inputs);
  }, [loadedById, annotationsByKey, costBasisOverrideByHash]);
  const realizedByFamily = ucb.realizedByFamily;
  const rewardIncomeByFamily = ucb.rewardIncomeByFamily;

  const totalUsd = rollups.reduce((s, r) => s + r.totalUsd, 0);
  const totalCost = rollups.reduce((s, r) => s + r.totalCostBasisUsd, 0);
  const totalPnl = totalUsd - totalCost;
  const totalRealized = [...realizedByFamily.values()].reduce(
    (s, r) => s + r.realizedUsd,
    0,
  );
  const totalRewardIncome = [...rewardIncomeByFamily.values()].reduce(
    (s, r) => s + r.fmvUsd,
    0,
  );

  const toggle = (family: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(family)) next.delete(family);
      else next.add(family);
      return next;
    });
  };

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Unified asset view
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Сводно по всем кошелькам — суммарный amount, cost basis, PnL для
          каждого токена. Кликни строку чтобы раскрыть breakdown по wallet ×
          chain. CEX-баланс — в backlog (B3 internal transfers).
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              Total value
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">
              {formatUsd(totalUsd)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              Total cost basis
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">
              {formatUsd(totalCost)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              Unrealized PnL
            </div>
            <div
              className={
                "mt-1 text-2xl font-semibold tabular-nums " +
                (totalPnl > 0
                  ? "text-emerald-400"
                  : totalPnl < 0
                    ? "text-destructive"
                    : "")
              }
            >
              {totalPnl >= 0 ? "+" : ""}
              {formatUsd(totalPnl)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              Realized PnL
            </div>
            <div
              className={
                "mt-1 text-2xl font-semibold tabular-nums " +
                (totalRealized > 0
                  ? "text-emerald-400"
                  : totalRealized < 0
                    ? "text-destructive"
                    : "")
              }
              title="UCB E3: только non-stable → stable swaps + withdraw_fiat. Token-to-token swaps и LP-removes не учитываются."
            >
              {totalRealized >= 0 ? "+" : ""}
              {formatUsd(totalRealized)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              Reward income
            </div>
            <div
              className="mt-1 text-2xl font-semibold tabular-nums text-amber-400"
              title="UCB D6: суммарный FMV (fair-market value) на момент получения всех claim_rewards. Это income, не PnL — gain фиксируется при продаже за стейбл (уже в Realized)."
            >
              {formatUsd(totalRewardIncome)}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Активы ({rollups.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {/* Desktop: таблица */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-y border-border bg-secondary/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium w-32">
                    Asset
                  </th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                  <th className="px-3 py-2 text-right font-medium">WAC</th>
                  <th className="px-3 py-2 text-right font-medium">Cost basis</th>
                  <th className="px-3 py-2 text-right font-medium">Current</th>
                  <th className="px-3 py-2 text-right font-medium">Unrealized</th>
                  <th className="px-3 py-2 text-right font-medium">Realized</th>
                  <th className="px-3 py-2 text-right font-medium w-12"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rollups.length === 0 ? (
                  <tr>
                    <td
                      colSpan={8}
                      className="px-3 py-6 text-center text-muted-foreground"
                    >
                      Нет активов. Подключи кошелёк в Registry.
                    </td>
                  </tr>
                ) : (
                  rollups.map((r) => {
                    const isOpen = expanded.has(r.family);
                    const pnlClass =
                      r.unrealizedPnlUsd > 0
                        ? "text-emerald-400"
                        : r.unrealizedPnlUsd < 0
                          ? "text-destructive"
                          : "text-muted-foreground";
                    const rz = realizedByFamily.get(r.family);
                    const rzClass = rz
                      ? rz.realizedUsd > 0
                        ? "text-emerald-400"
                        : rz.realizedUsd < 0
                          ? "text-destructive"
                          : "text-muted-foreground"
                      : "text-muted-foreground";
                    return (
                      <>
                        <tr
                          key={r.family}
                          className="hover:bg-accent/40 cursor-pointer"
                          onClick={() => toggle(r.family)}
                        >
                          <td className="px-3 py-2 font-medium">{r.family}</td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {formatAmount(r.totalAmount)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                            {r.wac > 0 ? formatUsd(r.wac) : "—"}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {r.totalCostBasisUsd > 0
                              ? formatUsd(r.totalCostBasisUsd)
                              : "—"}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {formatUsd(r.totalUsd)}
                          </td>
                          <td
                            className={
                              "px-3 py-2 text-right tabular-nums " + pnlClass
                            }
                          >
                            {r.totalCostBasisUsd > 0 ? (
                              <>
                                <div>
                                  {r.unrealizedPnlUsd >= 0 ? "+" : ""}
                                  {formatUsd(r.unrealizedPnlUsd)}
                                </div>
                                <div className="text-[10px]">
                                  {formatPct(r.unrealizedPnlPct)}
                                </div>
                              </>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td
                            className={
                              "px-3 py-2 text-right tabular-nums " + rzClass
                            }
                            title={
                              rz
                                ? `${rz.eventCount} sale event${rz.eventCount === 1 ? "" : "s"}`
                                : "Нет реализованных продаж"
                            }
                          >
                            {rz && Math.abs(rz.realizedUsd) >= 0.01 ? (
                              <div>
                                {rz.realizedUsd >= 0 ? "+" : ""}
                                {formatUsd(rz.realizedUsd)}
                              </div>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right text-muted-foreground">
                            {isOpen ? "▾" : "▸"}
                          </td>
                        </tr>
                        {isOpen &&
                          r.sources.map((s) => (
                            <tr
                              key={`${r.family}-${s.sourceId}-${s.chain}`}
                              className="bg-secondary/20"
                            >
                              <td className="px-3 py-1.5 pl-8 text-muted-foreground">
                                <span className="inline-flex items-center gap-1.5">
                                  <span className="rounded border border-border bg-secondary px-1.5 py-0.5 text-[9px] uppercase tracking-wider">
                                    {s.chain}
                                  </span>
                                  {s.sourceName}
                                </span>
                              </td>
                              <td className="px-3 py-1.5 text-right tabular-nums">
                                {formatAmount(s.amount)}
                              </td>
                              <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                                {s.costBasisUsd > 0 && s.amount > 0
                                  ? formatUsd(s.costBasisUsd / s.amount)
                                  : "—"}
                              </td>
                              <td className="px-3 py-1.5 text-right tabular-nums">
                                {s.costBasisUsd > 0
                                  ? formatUsd(s.costBasisUsd)
                                  : "—"}
                              </td>
                              <td className="px-3 py-1.5 text-right tabular-nums">
                                {formatUsd(s.usd)}
                              </td>
                              <td
                                className="px-3 py-1.5 text-right tabular-nums text-muted-foreground"
                                colSpan={3}
                              >
                                {s.costBasisUsd > 0
                                  ? formatUsd(s.usd - s.costBasisUsd)
                                  : "—"}
                              </td>
                            </tr>
                          ))}
                      </>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Mobile: карточки */}
          <ul className="md:hidden divide-y divide-border border-y border-border">
            {rollups.length === 0 ? (
              <li className="px-4 py-6 text-center text-xs text-muted-foreground">
                Нет активов. Подключи кошелёк в Registry.
              </li>
            ) : (
              rollups.map((r) => {
                const isOpen = expanded.has(r.family);
                const pnlClass =
                  r.unrealizedPnlUsd > 0
                    ? "text-emerald-400"
                    : r.unrealizedPnlUsd < 0
                      ? "text-destructive"
                      : "text-muted-foreground";
                const rz = realizedByFamily.get(r.family);
                const rzClass = rz
                  ? rz.realizedUsd > 0
                    ? "text-emerald-400"
                    : rz.realizedUsd < 0
                      ? "text-destructive"
                      : "text-muted-foreground"
                  : "text-muted-foreground";
                return (
                  <li key={r.family} className="text-xs">
                    <button
                      type="button"
                      onClick={() => toggle(r.family)}
                      className="w-full px-4 py-3 text-left hover:bg-accent/40"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="font-medium text-sm">{r.family}</div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="tabular-nums font-semibold">
                            {formatUsd(r.totalUsd)}
                          </span>
                          <span className="text-muted-foreground">
                            {isOpen ? "▾" : "▸"}
                          </span>
                        </div>
                      </div>
                      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">Amount</dt>
                          <dd className="tabular-nums">{formatAmount(r.totalAmount)}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">WAC</dt>
                          <dd className="tabular-nums text-muted-foreground">
                            {r.wac > 0 ? formatUsd(r.wac) : "—"}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">Cost basis</dt>
                          <dd className="tabular-nums">
                            {r.totalCostBasisUsd > 0 ? formatUsd(r.totalCostBasisUsd) : "—"}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">Unrealized</dt>
                          <dd className={"tabular-nums " + pnlClass}>
                            {r.totalCostBasisUsd > 0 ? (
                              <>
                                {r.unrealizedPnlUsd >= 0 ? "+" : ""}
                                {formatUsd(r.unrealizedPnlUsd)}{" "}
                                <span className="text-[10px]">({formatPct(r.unrealizedPnlPct)})</span>
                              </>
                            ) : (
                              "—"
                            )}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2 col-span-2">
                          <dt className="text-muted-foreground">Realized</dt>
                          <dd className={"tabular-nums " + rzClass}>
                            {rz && Math.abs(rz.realizedUsd) >= 0.01
                              ? `${rz.realizedUsd >= 0 ? "+" : ""}${formatUsd(rz.realizedUsd)}`
                              : "—"}
                          </dd>
                        </div>
                      </dl>
                    </button>
                    {isOpen && (
                      <ul className="divide-y divide-border/40 border-t border-border/40 bg-secondary/20">
                        {r.sources.map((s) => (
                          <li
                            key={`${r.family}-${s.sourceId}-${s.chain}`}
                            className="px-4 py-2"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="inline-flex items-center gap-1.5 min-w-0">
                                <span className="rounded border border-border bg-secondary px-1.5 py-0.5 text-[9px] uppercase tracking-wider shrink-0">
                                  {s.chain}
                                </span>
                                <span className="text-muted-foreground truncate">{s.sourceName}</span>
                              </span>
                              <span className="tabular-nums shrink-0">{formatUsd(s.usd)}</span>
                            </div>
                            <div className="mt-1 flex justify-between gap-2 text-[11px] text-muted-foreground">
                              <span className="tabular-nums">{formatAmount(s.amount)}</span>
                              <span className="tabular-nums">
                                cb: {s.costBasisUsd > 0 ? formatUsd(s.costBasisUsd) : "—"}
                              </span>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })
            )}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
