/**
 * UCB C3: global timeline UI — единый chronological feed всех событий
 * пользователя через все wallets.
 *
 * Source: `loadedById` из `LoadedWalletsProvider` → ops каждого wallet'а →
 * сливаем + сортируем по времени desc. CEX-side (trades, transfers, P2P)
 * пока не интегрированы; backlog C3.2 объединит и их через server-side
 * unified events API.
 *
 * Учитывает UCB D8: excluded ops помечаются визуально (но не filter'ятся,
 * пользователь должен видеть что было excluded для debugging).
 *
 * Filters: chain / wallet / op type / search by hash.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLoadedWallets } from "@/components/data/LoadedWalletsProvider";
import {
  useCexTaxEvents,
  useCexTransfersWithHash,
} from "@/features/cex/hooks";
import type { ClassifiedOp, OpType } from "@/lib/portfolio/types";

/**
 * C3.2: unified feed item = on-chain op ИЛИ CEX-side event.
 * Discriminated union по `kind` для render-time switching.
 */
type UnifiedFeedItem =
  | OnChainFeedItem
  | CexFeedItem;

interface OnChainFeedItem {
  readonly kind: "on-chain";
  readonly time: number; // unix sec
  readonly op: ClassifiedOp;
  readonly walletId: string;
  readonly walletName: string;
  readonly walletChain: string;
  readonly excluded: boolean;
  readonly manualOpType: string | null;
  readonly manualCostBasisUsd: number | null;
}

interface CexFeedItem {
  readonly kind: "cex";
  readonly time: number;
  readonly source: "tax-event" | "transfer";
  readonly subtype: string; // sale / exchange / income / deposit / withdrawal
  readonly exchange: string;
  readonly label: string | null;
  readonly asset: string;
  readonly amount: number;
  /** USD value (proceedsUsd для tax events / amount для stable). */
  readonly usd: number;
  readonly txHash: string | null;
  readonly note?: string;
}

// Backward-compat alias.
type FeedItem = OnChainFeedItem;

const OP_TYPE_COLOR: Partial<Record<OpType, string>> = {
  swap: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  transfer_in: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  transfer_out: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  deposit_fiat: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  withdraw_fiat: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  bridge_in: "bg-purple-500/15 text-purple-300 border-purple-500/30",
  bridge_out: "bg-purple-500/15 text-purple-300 border-purple-500/30",
  lp_add: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  lp_remove: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  lend_supply: "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
  lend_withdraw: "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
  borrow: "bg-red-500/15 text-red-300 border-red-500/30",
  repay: "bg-red-500/15 text-red-300 border-red-500/30",
  stake: "bg-teal-500/15 text-teal-300 border-teal-500/30",
  unstake: "bg-teal-500/15 text-teal-300 border-teal-500/30",
  claim_rewards: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  approve: "bg-muted text-muted-foreground border-border",
  failed: "bg-destructive/20 text-destructive border-destructive/30",
  gas_topup: "bg-muted text-muted-foreground border-border",
  unknown: "bg-muted text-muted-foreground border-border",
};

const DEFAULT_BADGE = "bg-muted text-muted-foreground border-border";

const PAGE_SIZE = 100;

function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs < 0.01) return "$0";
  return n.toLocaleString("ru-RU", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: abs < 1 ? 4 : 2,
  });
}

function formatAmount(n: number): string {
  if (n < 0.001) return n.toFixed(6);
  if (n < 1) return n.toFixed(4);
  if (n < 1000) return n.toFixed(3);
  return n.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
}

function formatDateTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleString("ru-RU", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortHash(h: string): string {
  if (!h || h.length < 12) return h;
  return `${h.slice(0, 8)}…${h.slice(-6)}`;
}

export function TimelinePage(): JSX.Element {
  const { loadedById, annotationsByKey } = useLoadedWallets();
  // C3.2: CEX-side data
  const cexTaxQ = useCexTaxEvents();
  const cexTransfersQ = useCexTransfersWithHash();

  // Filter state
  const [filterChain, setFilterChain] = useState<string>("");
  const [filterWallet, setFilterWallet] = useState<string>("");
  const [filterOpType, setFilterOpType] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [showExcluded, setShowExcluded] = useState<boolean>(true);
  const [includeCex, setIncludeCex] = useState<boolean>(true);
  const [limit, setLimit] = useState<number>(PAGE_SIZE);

  // ─── derive merged feed ─────────────────────────────────────────────
  const allItems = useMemo<UnifiedFeedItem[]>(() => {
    const items: UnifiedFeedItem[] = [];
    // 1. On-chain ops
    for (const l of Object.values(loadedById)) {
      const realWalletId = l.wallet.id.startsWith("api:")
        ? (l.wallet.id.split(":")[1] ?? l.wallet.id)
        : l.wallet.id;
      for (const op of l.ops) {
        const k = `${realWalletId}|${op.hash.toLowerCase()}|0`;
        const ann = annotationsByKey.get(k);
        items.push({
          kind: "on-chain",
          time: op.time,
          op,
          walletId: l.wallet.id,
          walletName: l.wallet.name,
          walletChain: l.wallet.chain,
          excluded: ann?.excluded === true,
          manualOpType: ann?.manualOpType ?? null,
          manualCostBasisUsd: ann?.manualCostBasisUsd ?? null,
        });
      }
    }
    // 2. CEX tax events (P2P sales + trades)
    if (includeCex && cexTaxQ.data?.events) {
      for (const e of cexTaxQ.data.events) {
        items.push({
          kind: "cex",
          time: Math.floor(new Date(e.disposedAt).getTime() / 1000),
          source: "tax-event",
          subtype: e.eventType, // 'sale' | 'exchange' | 'income'
          exchange: e.exchange,
          label: e.label,
          asset: e.asset,
          amount: e.amount,
          usd: e.proceedsUsd,
          txHash: `${e.source}:${e.sourceId}`,
          note: e.gainUsd >= 0 ? `+${e.gainUsd.toFixed(2)}` : e.gainUsd.toFixed(2),
        });
      }
    }
    // 3. CEX transfers (deposits + withdrawals with hash)
    if (includeCex && cexTransfersQ.data) {
      for (const t of cexTransfersQ.data) {
        items.push({
          kind: "cex",
          time: Math.floor(new Date(t.executedAt).getTime() / 1000),
          source: "transfer",
          subtype: t.direction, // 'deposit' | 'withdrawal'
          exchange: t.exchange,
          label: t.label,
          asset: t.asset,
          amount: Number(t.amount),
          usd: 0, // CEX transfer USD не возвращается в response — skip
          txHash: t.txHash,
        });
      }
    }
    items.sort((a, b) => b.time - a.time);
    return items;
  }, [loadedById, annotationsByKey, includeCex, cexTaxQ.data, cexTransfersQ.data]);

  // ─── apply filters ──────────────────────────────────────────────────
  const filtered = useMemo<UnifiedFeedItem[]>(() => {
    return allItems.filter((it) => {
      if (it.kind === "on-chain") {
        if (filterChain && it.op.chain !== filterChain) return false;
        if (filterWallet && it.walletId !== filterWallet) return false;
        if (filterOpType && it.op.type !== filterOpType) return false;
        if (!showExcluded && it.excluded) return false;
        if (search) {
          const q = search.toLowerCase();
          if (
            !it.op.hash.toLowerCase().includes(q) &&
            !it.walletName.toLowerCase().includes(q) &&
            !it.op.movement.some((m) => m.symbol.toLowerCase().includes(q))
          ) {
            return false;
          }
        }
      } else {
        if (filterChain) return false; // CEX rows не имеют chain
        if (filterWallet) return false; // CEX rows не имеют wallet
        if (filterOpType && it.subtype !== filterOpType) return false;
        if (search) {
          const q = search.toLowerCase();
          if (
            !it.exchange.toLowerCase().includes(q) &&
            !it.asset.toLowerCase().includes(q) &&
            !(it.txHash?.toLowerCase().includes(q))
          ) {
            return false;
          }
        }
      }
      return true;
    });
  }, [allItems, filterChain, filterWallet, filterOpType, search, showExcluded]);

  const visible = filtered.slice(0, limit);
  const hasMore = filtered.length > limit;

  // ─── unique chains / wallets / opTypes для select dropdowns ─────────
  const uniqueChains = useMemo(() => {
    const s = new Set<string>();
    for (const it of allItems) {
      if (it.kind === "on-chain") s.add(it.op.chain);
    }
    return [...s].sort();
  }, [allItems]);

  const uniqueWallets = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of allItems) {
      if (it.kind === "on-chain") m.set(it.walletId, it.walletName);
    }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [allItems]);

  const uniqueOpTypes = useMemo(() => {
    const s = new Set<string>();
    for (const it of allItems) {
      s.add(it.kind === "on-chain" ? it.op.type : it.subtype);
    }
    return [...s].sort();
  }, [allItems]);

  // ─── summary stats ──────────────────────────────────────────────────
  const totalCount = allItems.length;
  const cexCount = allItems.filter((it) => it.kind === "cex").length;
  const filteredCount = filtered.length;
  const excludedCount = allItems.filter(
    (it) => it.kind === "on-chain" && it.excluded,
  ).length;
  const manualOverrideCount = allItems.filter(
    (it) =>
      it.kind === "on-chain" &&
      (it.manualOpType != null || it.manualCostBasisUsd != null),
  ).length;

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Лента событий</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Все on-chain операции пользователя через все wallets, сортированы по
          времени. UCB D8 excluded ops помечены крестиком; manual annotations
          (A3) — карандашом. CEX-side timeline (trades / P2P / transfers) — в
          backlog C3.2.
        </p>
      </div>

      {/* ─── Stats strip ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-4">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Total ops
            </div>
            <div className="mt-1 text-xl font-semibold tabular-nums">
              {totalCount.toLocaleString("ru-RU")}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              After filters
            </div>
            <div className="mt-1 text-xl font-semibold tabular-nums">
              {filteredCount.toLocaleString("ru-RU")}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div
              className="text-[10px] uppercase tracking-wider text-muted-foreground"
              title="UCB D8: ops помеченные user'ом как soft-deleted"
            >
              Excluded (D8)
            </div>
            <div className="mt-1 text-xl font-semibold tabular-nums text-destructive">
              {excludedCount.toLocaleString("ru-RU")}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div
              className="text-[10px] uppercase tracking-wider text-muted-foreground"
              title="UCB A3/A4: ops с manual op_type / cost basis override"
            >
              Manual overrides
            </div>
            <div className="mt-1 text-xl font-semibold tabular-nums text-amber-400">
              {manualOverrideCount.toLocaleString("ru-RU")}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ─── Filters ─────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="min-w-[160px]">
              <label className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                Chain
              </label>
              <select
                value={filterChain}
                onChange={(e) => setFilterChain(e.target.value)}
                className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs"
              >
                <option value="">All chains</option>
                {uniqueChains.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-[180px]">
              <label className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                Wallet
              </label>
              <select
                value={filterWallet}
                onChange={(e) => setFilterWallet(e.target.value)}
                className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs"
              >
                <option value="">All wallets</option>
                {uniqueWallets.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-[160px]">
              <label className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                Op type
              </label>
              <select
                value={filterOpType}
                onChange={(e) => setFilterOpType(e.target.value)}
                className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs"
              >
                <option value="">All types</option>
                {uniqueOpTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-[200px] flex-1">
              <label className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                Поиск (hash / wallet / symbol)
              </label>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="0x... / Cold / USDT"
                className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs"
              />
            </div>
            <label className="flex items-center gap-1.5 text-xs cursor-pointer pb-1">
              <input
                type="checkbox"
                checked={showExcluded}
                onChange={(e) => setShowExcluded(e.target.checked)}
                className="accent-destructive"
              />
              <span>Показать excluded</span>
            </label>
            <label className="flex items-center gap-1.5 text-xs cursor-pointer pb-1">
              <input
                type="checkbox"
                checked={includeCex}
                onChange={(e) => setIncludeCex(e.target.checked)}
                className="accent-purple-500"
              />
              <span title="C3.2: CEX trades / P2P / transfers merged into the feed">
                Включить CEX events ({cexCount})
              </span>
            </label>
          </div>
        </CardContent>
      </Card>

      {/* ─── Feed ───────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Events ({visible.length}/{filtered.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {/* Desktop */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-y border-border bg-secondary/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium w-44">Time</th>
                  <th className="px-3 py-2 text-left font-medium w-32">Source</th>
                  <th className="px-3 py-2 text-left font-medium w-20">Chain</th>
                  <th className="px-3 py-2 text-left font-medium w-32">Type</th>
                  <th className="px-3 py-2 text-left font-medium">Movements</th>
                  <th className="px-3 py-2 text-right font-medium w-24">Net</th>
                  <th className="px-3 py-2 text-left font-medium w-40">Tx</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visible.length === 0 ? (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-3 py-12 text-center text-muted-foreground"
                    >
                      {totalCount === 0
                        ? "Нет операций. Подключи кошелёк в Registry."
                        : "Нет операций по выбранным фильтрам."}
                    </td>
                  </tr>
                ) : (
                  visible.map((it, idx) => {
                    if (it.kind === "cex") {
                      return (
                        <tr
                          key={`cex:${it.exchange}:${it.txHash ?? idx}:${idx}`}
                          className="hover:bg-accent/30 bg-purple-500/[0.03]"
                        >
                          <td className="px-3 py-2 tabular-nums text-muted-foreground">
                            {formatDateTime(it.time)}
                          </td>
                          <td className="px-3 py-2">
                            <span
                              className="rounded border border-purple-500/30 bg-purple-500/15 text-purple-300 px-1.5 py-0.5 text-[10px] uppercase font-medium"
                              title={`CEX-side event (UCB C3.2): ${it.label ?? it.exchange}`}
                            >
                              {it.exchange}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <Badge variant="outline" className="text-[9px] uppercase">
                              cex
                            </Badge>
                          </td>
                          <td className="px-3 py-2">
                            <span
                              className={
                                "inline-block rounded border px-1.5 py-0.5 text-[10px] " +
                                (it.subtype === "sale" || it.subtype === "withdrawal"
                                  ? "bg-rose-500/15 text-rose-300 border-rose-500/30"
                                  : it.subtype === "income"
                                    ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
                                    : it.subtype === "deposit"
                                      ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                                      : "bg-cyan-500/15 text-cyan-300 border-cyan-500/30")
                              }
                            >
                              {it.subtype}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <span className="inline-flex items-center gap-1 rounded border border-muted px-1.5 py-0.5 text-[10px]">
                              <span className="tabular-nums">
                                {formatAmount(it.amount)}
                              </span>
                              <span className="font-medium">{it.asset}</span>
                              {it.usd > 0 && (
                                <span className="text-muted-foreground/70 text-[9px]">
                                  ({formatUsd(it.usd)})
                                </span>
                              )}
                            </span>
                          </td>
                          <td
                            className={
                              "px-3 py-2 text-right tabular-nums " +
                              (it.note?.startsWith("+")
                                ? "text-emerald-400"
                                : it.note?.startsWith("-")
                                  ? "text-destructive"
                                  : "text-muted-foreground")
                            }
                          >
                            {it.note ?? "—"}
                          </td>
                          <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground">
                            {it.txHash ? shortHash(it.txHash) : "—"}
                          </td>
                        </tr>
                      );
                    }
                    const op = it.op;
                    const displayedType = it.manualOpType ?? op.type;
                    const colorClass =
                      OP_TYPE_COLOR[displayedType as OpType] ?? DEFAULT_BADGE;
                    return (
                      <tr
                        key={`${op.chain}:${op.hash}:${idx}`}
                        className={
                          "hover:bg-accent/30 " +
                          (it.excluded ? "opacity-50 line-through" : "")
                        }
                      >
                        <td className="px-3 py-2 tabular-nums text-muted-foreground">
                          {formatDateTime(op.time)}
                        </td>
                        <td className="px-3 py-2">
                          <Link
                            to={`/wallet/${it.walletId.startsWith("api:") ? it.walletId.split(":")[1] : it.walletId}`}
                            className="text-brand-cyan hover:underline"
                          >
                            {it.walletName}
                          </Link>
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant="outline" className="text-[9px] uppercase">
                            {op.chain}
                          </Badge>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1">
                            <span
                              className={
                                "inline-block rounded border px-1.5 py-0.5 text-[10px] " +
                                colorClass
                              }
                              title={
                                it.manualOpType
                                  ? `Manual override (UCB A3): ${op.type} → ${it.manualOpType}`
                                  : undefined
                              }
                            >
                              {displayedType}
                              {it.manualOpType && (
                                <span className="ml-1 opacity-70">✎</span>
                              )}
                            </span>
                            {it.excluded && (
                              <span
                                className="text-destructive text-[10px]"
                                title="UCB D8: soft-deleted, не учитывается в UCB pipeline"
                              >
                                ✕
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          {op.movement.length === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <div className="flex flex-wrap gap-1">
                              {op.movement.slice(0, 4).map((m, i) => (
                                <span
                                  key={i}
                                  className={
                                    "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] " +
                                    (m.direction === "in"
                                      ? "border-emerald-500/30 text-emerald-300"
                                      : "border-rose-500/30 text-rose-300")
                                  }
                                >
                                  <span>{m.direction === "in" ? "+" : "−"}</span>
                                  <span className="tabular-nums">
                                    {formatAmount(m.amount)}
                                  </span>
                                  <span className="font-medium">{m.symbol}</span>
                                  {m.usd != null && m.usd >= 1 && (
                                    <span className="text-muted-foreground/70 text-[9px]">
                                      ({formatUsd(m.usd)})
                                    </span>
                                  )}
                                </span>
                              ))}
                              {op.movement.length > 4 && (
                                <span className="text-[10px] text-muted-foreground self-center">
                                  +{op.movement.length - 4}
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {op.netUsd !== 0 ? formatUsd(op.netUsd) : "—"}
                        </td>
                        <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground">
                          {shortHash(op.hash)}
                          {it.manualCostBasisUsd != null && (
                            <span
                              className="ml-1.5 text-amber-400 text-[10px]"
                              title={`Manual cost basis (UCB A4): ${formatUsd(it.manualCostBasisUsd)}`}
                            >
                              $
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Mobile */}
          <ul className="md:hidden divide-y divide-border border-y border-border">
            {visible.length === 0 ? (
              <li className="px-4 py-12 text-center text-xs text-muted-foreground">
                {totalCount === 0
                  ? "Нет операций. Подключи кошелёк в Registry."
                  : "Нет операций по выбранным фильтрам."}
              </li>
            ) : (
              visible.map((it, idx) => {
                if (it.kind === "cex") {
                  const noteColor = it.note?.startsWith("+")
                    ? "text-emerald-400"
                    : it.note?.startsWith("-")
                      ? "text-destructive"
                      : "text-muted-foreground";
                  return (
                    <li
                      key={`cex:${it.exchange}:${it.txHash ?? idx}:${idx}`}
                      className="px-4 py-3 text-xs bg-purple-500/[0.03]"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                          <span className="rounded border border-purple-500/30 bg-purple-500/15 text-purple-300 px-1.5 py-0.5 text-[10px] uppercase font-medium">
                            {it.exchange}
                          </span>
                          <Badge variant="outline" className="text-[9px] uppercase">cex</Badge>
                          <span
                            className={
                              "inline-block rounded border px-1.5 py-0.5 text-[10px] " +
                              (it.subtype === "sale" || it.subtype === "withdrawal"
                                ? "bg-rose-500/15 text-rose-300 border-rose-500/30"
                                : it.subtype === "income"
                                  ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
                                  : it.subtype === "deposit"
                                    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                                    : "bg-cyan-500/15 text-cyan-300 border-cyan-500/30")
                            }
                          >
                            {it.subtype}
                          </span>
                        </div>
                        <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                          {formatDateTime(it.time)}
                        </span>
                      </div>
                      <div className="mt-2 inline-flex items-center gap-1 rounded border border-muted px-1.5 py-0.5 text-[11px]">
                        <span className="tabular-nums">{formatAmount(it.amount)}</span>
                        <span className="font-medium">{it.asset}</span>
                        {it.usd > 0 && (
                          <span className="text-muted-foreground/70 text-[9px]">
                            ({formatUsd(it.usd)})
                          </span>
                        )}
                      </div>
                      <div className="mt-1.5 flex justify-between gap-2 text-[11px]">
                        <span className={"tabular-nums " + noteColor}>{it.note ?? "—"}</span>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {it.txHash ? shortHash(it.txHash) : "—"}
                        </span>
                      </div>
                    </li>
                  );
                }
                const op = it.op;
                const displayedType = it.manualOpType ?? op.type;
                const colorClass = OP_TYPE_COLOR[displayedType as OpType] ?? DEFAULT_BADGE;
                return (
                  <li
                    key={`${op.chain}:${op.hash}:${idx}`}
                    className={
                      "px-4 py-3 text-xs " +
                      (it.excluded ? "opacity-50 line-through" : "")
                    }
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                        <Link
                          to={`/wallet/${it.walletId.startsWith("api:") ? it.walletId.split(":")[1] : it.walletId}`}
                          className="text-brand-cyan hover:underline"
                        >
                          {it.walletName}
                        </Link>
                        <Badge variant="outline" className="text-[9px] uppercase">{op.chain}</Badge>
                        <span className={"inline-block rounded border px-1.5 py-0.5 text-[10px] " + colorClass}>
                          {displayedType}
                          {it.manualOpType && <span className="ml-1 opacity-70">✎</span>}
                        </span>
                        {it.excluded && (
                          <span className="text-destructive text-[10px]">✕</span>
                        )}
                      </div>
                      <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                        {formatDateTime(op.time)}
                      </span>
                    </div>
                    {op.movement.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {op.movement.slice(0, 4).map((m, i) => (
                          <span
                            key={i}
                            className={
                              "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] " +
                              (m.direction === "in"
                                ? "border-emerald-500/30 text-emerald-300"
                                : "border-rose-500/30 text-rose-300")
                            }
                          >
                            <span>{m.direction === "in" ? "+" : "−"}</span>
                            <span className="tabular-nums">{formatAmount(m.amount)}</span>
                            <span className="font-medium">{m.symbol}</span>
                            {m.usd != null && m.usd >= 1 && (
                              <span className="text-muted-foreground/70 text-[9px]">
                                ({formatUsd(m.usd)})
                              </span>
                            )}
                          </span>
                        ))}
                        {op.movement.length > 4 && (
                          <span className="text-[10px] text-muted-foreground self-center">
                            +{op.movement.length - 4}
                          </span>
                        )}
                      </div>
                    )}
                    <div className="mt-1.5 flex justify-between gap-2 text-[11px]">
                      <span className="tabular-nums text-muted-foreground">
                        {op.netUsd !== 0 ? `Net ${formatUsd(op.netUsd)}` : ""}
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {shortHash(op.hash)}
                        {it.manualCostBasisUsd != null && (
                          <span className="ml-1.5 text-amber-400">$</span>
                        )}
                      </span>
                    </div>
                  </li>
                );
              })
            )}
          </ul>

          {hasMore && (
            <div className="border-t border-border p-3 text-center">
              <button
                type="button"
                onClick={() => setLimit(limit + PAGE_SIZE)}
                className="text-xs text-brand-cyan hover:underline"
              >
                Показать ещё {Math.min(PAGE_SIZE, filtered.length - limit)} операций
              </button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
