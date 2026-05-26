/**
 * UCB B4: страница "Coverage" — что-где-сколько просинкано.
 *
 * Одна страница, две таблицы:
 *   1. On-chain wallets — last sync / ops count / errors
 *   2. CEX accounts — last sync (per data-type) / counts trades/transfers/p2p
 *
 * Badge-логика: 🟢 < 24h, 🟡 < 7d, 🔴 > 7d / never. Errors помечаются
 * отдельно красной плашкой. Click через wallet name → /wallet/:id.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useSyncCoverage } from "@/features/sync-coverage/hooks";
import { useAuth } from "@/features/auth/AuthProvider";
import { cexApi } from "@/features/cex/api";
import { useCexAssetGaps } from "@/features/cex/hooks";

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "никогда";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "только что";
  if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} д назад`;
  const mo = Math.floor(d / 30);
  return `${mo} мес назад`;
}

function freshnessBadge(iso: string | null): {
  emoji: string;
  className: string;
} {
  if (!iso) {
    return {
      emoji: "🔴",
      className: "border-destructive/40 bg-destructive/10 text-destructive",
    };
  }
  const ms = Date.now() - Date.parse(iso);
  if (ms < 24 * 60 * 60_000) {
    return {
      emoji: "🟢",
      className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
    };
  }
  if (ms < 7 * 24 * 60 * 60_000) {
    return {
      emoji: "🟡",
      className: "border-amber-500/40 bg-amber-500/10 text-amber-400",
    };
  }
  return {
    emoji: "🔴",
    className: "border-destructive/40 bg-destructive/10 text-destructive",
  };
}

export function CoveragePage(): JSX.Element {
  const auth = useAuth();
  const q = useSyncCoverage(!!auth.user?.id);
  // Bob-test fix #5: asset gap warnings — surface missing-acquisition flags.
  const gapsQ = useCexAssetGaps();
  const qc = useQueryClient();
  const [syncingId, setSyncingId] = useState<string | null>(null);

  // UCB B3: sync internal transfers (Spot↔Funding↔Earn↔Sub-account).
  // После успешного push'а invalidate coverage чтобы свежие counts /
  // last_sync timestamps подтянулись.
  const syncInternal = useMutation({
    mutationFn: (id: string) => cexApi.syncInternalTransfers(id),
    onMutate: (id) => setSyncingId(id),
    onSettled: () => {
      setSyncingId(null);
      qc.invalidateQueries({ queryKey: ["sync-coverage"] });
    },
  });

  // UCB B4: ledger sync — master record (trades + transfers + fees + rebates +
  // interest + staking + funding). Comprehensive single-stream через
  // CCXT fetchLedger. Backfill до 24 месяцев истории.
  const syncLedger = useMutation({
    mutationFn: (id: string) => cexApi.syncLedger(id),
    onMutate: (id) => setSyncingId(id),
    onSettled: () => {
      setSyncingId(null);
      qc.invalidateQueries({ queryKey: ["sync-coverage"] });
    },
  });

  if (q.isLoading) {
    return <p className="p-6 text-muted-foreground">Загружаем…</p>;
  }
  if (q.isError) {
    return (
      <p className="p-6 text-destructive">
        Ошибка: {(q.error as Error).message}
      </p>
    );
  }
  const data = q.data;
  if (!data) return <></>;

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Покрытие данных
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Что-где-сколько просинкано. 🟢 &lt; 24ч · 🟡 &lt; 7д · 🔴 &gt; 7д
          или ошибка. Click по имени → детали.
        </p>
      </div>

      {/* Bob-test fix #5: asset gap warnings */}
      {gapsQ.data && gapsQ.data.gaps.length > 0 && (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              ⚠️ Missing acquisition data ({gapsQ.data.gaps.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Эти активы вы продавали или выводили больше, чем покупали +
              депонировали. Скорее всего CEX-deposits история не подтянулась
              (BingX/Bybit API limit) — cost basis для них стартует с $0,
              реализованный gain в Tax export будет завышен.
            </p>
            <div className="rounded border border-border">
              {/* Desktop: таблица */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-secondary/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-3 py-1.5 text-left">Asset</th>
                      <th className="px-3 py-1.5 text-left">Issue</th>
                      <th className="px-3 py-1.5 text-right">Bought + Deposited</th>
                      <th className="px-3 py-1.5 text-right">Sold + Withdrawn</th>
                      <th className="px-3 py-1.5 text-right">Missing</th>
                      <th className="px-3 py-1.5 text-right">Ratio</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {gapsQ.data.gaps.map((g) => (
                      <tr
                        key={g.asset}
                        className={
                          g.severity === "error"
                            ? "bg-destructive/5"
                            : "bg-amber-500/5"
                        }
                      >
                        <td className="px-3 py-1.5 font-medium">{g.asset}</td>
                        <td className="px-3 py-1.5 text-[11px]">
                          {g.kind === "no_acquisitions_at_all"
                            ? "Нет покупок / депозитов"
                            : "Outflow > inflow"}
                          <span
                            className={
                              "ml-1.5 rounded border px-1 py-0.5 text-[9px] uppercase " +
                              (g.severity === "error"
                                ? "border-destructive/30 text-destructive"
                                : "border-amber-500/30 text-amber-400")
                            }
                          >
                            {g.severity}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {g.inflow.toLocaleString("ru-RU", {
                            maximumFractionDigits: 4,
                          })}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {g.outflow.toLocaleString("ru-RU", {
                            maximumFractionDigits: 4,
                          })}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-destructive">
                          {g.missing.toLocaleString("ru-RU", {
                            maximumFractionDigits: 4,
                          })}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {Number.isFinite(g.ratio)
                            ? `${g.ratio.toFixed(1)}×`
                            : "∞"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile: карточки */}
              <ul className="md:hidden divide-y divide-border">
                {gapsQ.data.gaps.map((g) => (
                  <li
                    key={g.asset}
                    className={
                      "px-3 py-2.5 text-xs " +
                      (g.severity === "error" ? "bg-destructive/5" : "bg-amber-500/5")
                    }
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-sm">{g.asset}</span>
                      <span
                        className={
                          "rounded border px-1.5 py-0.5 text-[9px] uppercase " +
                          (g.severity === "error"
                            ? "border-destructive/30 text-destructive"
                            : "border-amber-500/30 text-amber-400")
                        }
                      >
                        {g.severity}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {g.kind === "no_acquisitions_at_all"
                        ? "Нет покупок / депозитов"
                        : "Outflow > inflow"}
                    </div>
                    <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Bought+Dep</dt>
                        <dd className="tabular-nums">
                          {g.inflow.toLocaleString("ru-RU", { maximumFractionDigits: 4 })}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Sold+Wdr</dt>
                        <dd className="tabular-nums">
                          {g.outflow.toLocaleString("ru-RU", { maximumFractionDigits: 4 })}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Missing</dt>
                        <dd className="tabular-nums text-destructive">
                          {g.missing.toLocaleString("ru-RU", { maximumFractionDigits: 4 })}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Ratio</dt>
                        <dd className="tabular-nums">
                          {Number.isFinite(g.ratio) ? `${g.ratio.toFixed(1)}×` : "∞"}
                        </dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Решение: (1) Re-sync CEX accounts с включёнными Deposit
              permissions; (2) Manual P2P import если активы получены через
              P2P; (3) Connect external wallet если активы пришли из
              cold-storage.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            On-chain кошельки ({data.wallets.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {/* Desktop: таблица */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-y border-border bg-secondary/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Кошелёк</th>
                  <th className="px-3 py-2 text-left font-medium">Сеть</th>
                  <th className="px-3 py-2 text-right font-medium">Ops в БД</th>
                  <th className="px-3 py-2 text-left font-medium">Last sync</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.wallets.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-3 py-6 text-center text-muted-foreground"
                    >
                      Нет кошельков
                    </td>
                  </tr>
                ) : (
                  data.wallets.map((w) => {
                    const badge = freshnessBadge(w.lastSyncAt);
                    return (
                      <tr key={w.id} className="hover:bg-accent/40">
                        <td className="px-3 py-2 font-medium">
                          <Link
                            to={`/wallet/${w.id}`}
                            className="text-brand-cyan hover:underline"
                          >
                            {w.name}
                          </Link>
                        </td>
                        <td className="px-3 py-2 uppercase text-muted-foreground">
                          {w.kind}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {w.opsCount > 0 ? (
                            w.opsCount.toLocaleString()
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {formatRelativeTime(w.lastSyncAt)}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={
                              "inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] " +
                              badge.className
                            }
                          >
                            {badge.emoji}{" "}
                            {w.lastSyncError
                              ? "ошибка"
                              : w.lastSyncAt
                                ? "ok"
                                : "не синканся"}
                          </span>
                          {w.lastSyncError && (
                            <div className="mt-1 text-[10px] text-destructive">
                              {w.lastSyncError.slice(0, 120)}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Mobile: карточки */}
          <ul className="md:hidden divide-y divide-border border-y border-border">
            {data.wallets.length === 0 ? (
              <li className="px-4 py-6 text-center text-xs text-muted-foreground">
                Нет кошельков
              </li>
            ) : (
              data.wallets.map((w) => {
                const badge = freshnessBadge(w.lastSyncAt);
                return (
                  <li key={w.id} className="px-4 py-3 text-xs">
                    <div className="flex items-start justify-between gap-2">
                      <Link
                        to={`/wallet/${w.id}`}
                        className="font-medium text-sm text-brand-cyan hover:underline truncate"
                      >
                        {w.name}
                      </Link>
                      <span
                        className={
                          "inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] shrink-0 " +
                          badge.className
                        }
                      >
                        {badge.emoji}{" "}
                        {w.lastSyncError ? "ошибка" : w.lastSyncAt ? "ok" : "не синканся"}
                      </span>
                    </div>
                    <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Сеть</dt>
                        <dd className="uppercase">{w.kind}</dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Ops</dt>
                        <dd className="tabular-nums">
                          {w.opsCount > 0 ? w.opsCount.toLocaleString() : "—"}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-2 col-span-2">
                        <dt className="text-muted-foreground">Last sync</dt>
                        <dd className="text-muted-foreground">
                          {formatRelativeTime(w.lastSyncAt)}
                        </dd>
                      </div>
                    </dl>
                    {w.lastSyncError && (
                      <div className="mt-1 text-[10px] text-destructive">
                        {w.lastSyncError.slice(0, 120)}
                      </div>
                    )}
                  </li>
                );
              })
            )}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            CEX аккаунты ({data.cexAccounts.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {/* Desktop: таблица */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-y border-border bg-secondary/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Биржа</th>
                  <th className="px-3 py-2 text-right font-medium">Trades</th>
                  <th className="px-3 py-2 text-right font-medium">Transfers</th>
                  <th className="px-3 py-2 text-right font-medium">
                    Internal
                  </th>
                  <th className="px-3 py-2 text-right font-medium">P2P</th>
                  <th className="px-3 py-2 text-left font-medium">Last sync</th>
                  <th className="px-3 py-2 text-left font-medium">
                    Last trades sync
                  </th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.cexAccounts.length === 0 ? (
                  <tr>
                    <td
                      colSpan={9}
                      className="px-3 py-6 text-center text-muted-foreground"
                    >
                      Нет подключённых бирж
                    </td>
                  </tr>
                ) : (
                  data.cexAccounts.map((a) => {
                    // Берём свежее из general/trades sync.
                    const newest =
                      a.lastSyncAt && a.lastTradesSyncAt
                        ? a.lastSyncAt > a.lastTradesSyncAt
                          ? a.lastSyncAt
                          : a.lastTradesSyncAt
                        : (a.lastSyncAt ?? a.lastTradesSyncAt);
                    const badge = freshnessBadge(newest);
                    const hasError = !!(
                      a.lastSyncError || a.lastTradesSyncError
                    );
                    return (
                      <tr key={a.id} className="hover:bg-accent/40">
                        <td className="px-3 py-2 font-medium">
                          <div>{a.exchange}</div>
                          {a.label && (
                            <div className="text-[10px] text-muted-foreground">
                              {a.label}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {a.tradesCount > 0
                            ? a.tradesCount.toLocaleString()
                            : "—"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {a.transfersCount > 0
                            ? a.transfersCount.toLocaleString()
                            : "—"}
                        </td>
                        <td
                          className="px-3 py-2 text-right tabular-nums"
                          title={
                            a.lastInternalTransfersSyncError ??
                            (a.lastInternalTransfersSyncAt
                              ? `Last sync: ${formatRelativeTime(a.lastInternalTransfersSyncAt)}`
                              : "Никогда не синканся")
                          }
                        >
                          {a.internalTransfersCount > 0
                            ? a.internalTransfersCount.toLocaleString()
                            : a.lastInternalTransfersSyncAt
                              ? "0"
                              : "—"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {a.p2pCount > 0 ? a.p2pCount.toLocaleString() : "—"}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {formatRelativeTime(a.lastSyncAt)}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {formatRelativeTime(a.lastTradesSyncAt)}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={
                              "inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] " +
                              badge.className
                            }
                          >
                            {badge.emoji}{" "}
                            {hasError ? "ошибка" : newest ? "ok" : "не синканся"}
                          </span>
                          {(a.lastSyncError || a.lastTradesSyncError) && (
                            <div className="mt-1 text-[10px] text-destructive">
                              {(a.lastSyncError ?? a.lastTradesSyncError ?? "")
                                .toString()
                                .slice(0, 120)}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {/* Removed standalone sync buttons — see
                              /registry page "Синхронизировать всё" which
                              now chains balance + trades + transfers +
                              internal transfers + P2P + ledger в одну
                              unified кнопку. */}
                          <span className="text-[10px] text-muted-foreground">
                            Sync через /registry
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Mobile: карточки */}
          <ul className="md:hidden divide-y divide-border border-y border-border">
            {data.cexAccounts.length === 0 ? (
              <li className="px-4 py-6 text-center text-xs text-muted-foreground">
                Нет подключённых бирж
              </li>
            ) : (
              data.cexAccounts.map((a) => {
                const newest =
                  a.lastSyncAt && a.lastTradesSyncAt
                    ? a.lastSyncAt > a.lastTradesSyncAt
                      ? a.lastSyncAt
                      : a.lastTradesSyncAt
                    : (a.lastSyncAt ?? a.lastTradesSyncAt);
                const badge = freshnessBadge(newest);
                const hasError = !!(a.lastSyncError || a.lastTradesSyncError);
                return (
                  <li key={a.id} className="px-4 py-3 text-xs">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium text-sm">{a.exchange}</div>
                        {a.label && (
                          <div className="text-[10px] text-muted-foreground truncate">
                            {a.label}
                          </div>
                        )}
                      </div>
                      <span
                        className={
                          "inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] shrink-0 " +
                          badge.className
                        }
                      >
                        {badge.emoji} {hasError ? "ошибка" : newest ? "ok" : "не синканся"}
                      </span>
                    </div>
                    <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Trades</dt>
                        <dd className="tabular-nums">
                          {a.tradesCount > 0 ? a.tradesCount.toLocaleString() : "—"}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Transfers</dt>
                        <dd className="tabular-nums">
                          {a.transfersCount > 0 ? a.transfersCount.toLocaleString() : "—"}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Internal</dt>
                        <dd className="tabular-nums">
                          {a.internalTransfersCount > 0
                            ? a.internalTransfersCount.toLocaleString()
                            : a.lastInternalTransfersSyncAt
                              ? "0"
                              : "—"}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">P2P</dt>
                        <dd className="tabular-nums">
                          {a.p2pCount > 0 ? a.p2pCount.toLocaleString() : "—"}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-2 col-span-2">
                        <dt className="text-muted-foreground">Last sync</dt>
                        <dd className="text-muted-foreground">
                          {formatRelativeTime(a.lastSyncAt)}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-2 col-span-2">
                        <dt className="text-muted-foreground">Last trades</dt>
                        <dd className="text-muted-foreground">
                          {formatRelativeTime(a.lastTradesSyncAt)}
                        </dd>
                      </div>
                    </dl>
                    {(a.lastSyncError || a.lastTradesSyncError) && (
                      <div className="mt-1 text-[10px] text-destructive">
                        {(a.lastSyncError ?? a.lastTradesSyncError ?? "")
                          .toString()
                          .slice(0, 120)}
                      </div>
                    )}
                    <div className="mt-2 text-[10px] text-muted-foreground">
                      Sync через /registry
                    </div>
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
