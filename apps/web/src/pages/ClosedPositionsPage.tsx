/**
 * Архив закрытых позиций.
 *
 * Реконструируется из истории операций (см. `buildClosedPositions`).
 * Эти данные **не учитываются** в аналитике дашборда / открытых позиций —
 * только лента событий для справки.
 */

import { useMemo, useState } from "react";
import { Archive, ArrowDownRight, ArrowUpRight, Filter } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useLoadedWallets } from "@/components/data/LoadedWalletsProvider";
import { useI18n } from "@/i18n/I18nProvider";
import { formatDateShort, formatUsd } from "@/i18n/format";
import { buildClosedPositions } from "@/lib/portfolio/closed_positions";
import { buildLiveProtocolKeys } from "@/lib/portfolio/open_positions";
import { useWalletHistPrices } from "@/lib/portfolio/use_hist_prices";
import { usePipelineSettings } from "@/lib/portfolio/pipeline_settings";
import { cn } from "@/lib/utils";

type SortKey = "closedAt" | "openedAt" | "ageDays" | "depositedUsd" | "pnlUsd";

const KIND_LABEL: Record<string, string> = {
  lending: "Лендинг",
  lp: "LP",
  staking: "Стейкинг",
  perp: "Perp",
  other: "Другое",
};

export function ClosedPositionsPage(): JSX.Element {
  const { loadedById } = useLoadedWallets();
  const { locale } = useI18n();

  const loadedList = useMemo(() => Object.values(loadedById), [loadedById]);
  const { histPrices } = useWalletHistPrices(loadedList);

  const closed = useMemo(() => {
    const list = loadedList.map((l) => ({
      wallet: l.wallet,
      ops: l.ops,
      ...(l.live !== undefined && { live: l.live }),
    }));
    const liveKeys = buildLiveProtocolKeys(list);
    return buildClosedPositions(list, liveKeys, histPrices);
  }, [loadedList, histPrices]);

  const [walletFilter, setWalletFilter] = useState<string | "all">("all");
  const [sortKey, setSortKey] = useState<SortKey>("closedAt");
  const [sortDesc, setSortDesc] = useState(true);
  const [pipelineSettings] = usePipelineSettings();

  const wallets = useMemo(
    () =>
      [
        ...new Map(
          Object.values(loadedById).map((l) => [l.wallet.id, l.wallet]),
        ).entries(),
      ].map(([id, w]) => ({ id, name: w.name, chain: w.chain })),
    [loadedById],
  );

  const view = useMemo(() => {
    let v = closed;
    // Скрываем unmatched циклы если пользователь отключил их в Settings.
    // Сохраняем только полные closures (running balance = 0 в истории).
    if (!pipelineSettings.inferredFallback) {
      v = v.filter((p) => p.closureType === "complete");
    }
    if (walletFilter !== "all") {
      v = v.filter((p) => p.walletId === walletFilter);
    }
    v = [...v].sort((a, b) => {
      const av = a[sortKey] as number;
      const bv = b[sortKey] as number;
      return sortDesc ? bv - av : av - bv;
    });
    return v;
  }, [closed, walletFilter, sortKey, sortDesc, pipelineSettings.inferredFallback]);

  const totalPnl = view.reduce((s, p) => s + p.pnlUsd, 0);
  const totalDeposited = view.reduce((s, p) => s + p.depositedUsd, 0);

  const setSort = (k: SortKey) => {
    if (sortKey === k) setSortDesc((d) => !d);
    else {
      setSortKey(k);
      setSortDesc(true);
    }
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Archive className="h-5 w-5 text-brand-cyan" />
          <h1 className="text-2xl font-semibold tracking-tight">
            Лист закрытых позиций
          </h1>
          <Badge variant="muted" className="ml-1">
            {closed.length}
          </Badge>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Архив завершённых позиций — каждая строка это полный цикл
          открытия → закрытия. <b>Не учитывается</b> в аналитике дашборда
          и Листа открытых позиций.
        </p>
      </div>

      {closed.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            Нет закрытых позиций в истории. Когда вы откроете и закроете
            позицию (lp_add → lp_remove, lend_supply → lend_withdraw,
            stake → unstake), она появится здесь.
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Сводка */}
          <div className="grid gap-3 sm:grid-cols-3">
            <SummaryCard
              label="Закрыто позиций"
              value={String(view.length)}
              sub={
                walletFilter !== "all"
                  ? `по фильтру (всего ${closed.length})`
                  : "за всё время"
              }
            />
            <SummaryCard
              label="Σ Депонировано"
              value={formatUsd(totalDeposited, locale)}
              sub="за все циклы"
            />
            <SummaryCard
              label="Σ PnL"
              value={`${totalPnl >= 0 ? "+" : ""}${formatUsd(totalPnl, locale)}`}
              accent={totalPnl >= 0 ? "success" : "destructive"}
              sub="из закрытых позиций"
            />
          </div>

          {/* Filter */}
          <div className="flex flex-wrap items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Кошелёк:</span>
            <button
              type="button"
              onClick={() => setWalletFilter("all")}
              className={cn(
                "rounded-md border px-2 py-1 text-xs transition-colors",
                walletFilter === "all"
                  ? "border-brand-cyan/50 bg-brand-cyan/10 text-brand-cyan"
                  : "border-border bg-secondary/30 text-muted-foreground hover:text-foreground",
              )}
            >
              Все
            </button>
            {wallets.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => setWalletFilter(w.id)}
                className={cn(
                  "rounded-md border px-2 py-1 text-xs transition-colors",
                  walletFilter === w.id
                    ? "border-brand-cyan/50 bg-brand-cyan/10 text-brand-cyan"
                    : "border-border bg-secondary/30 text-muted-foreground hover:text-foreground",
                )}
              >
                {w.name}
              </button>
            ))}
          </div>

          {/* Таблица */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Закрытые позиции</CardTitle>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              {/* Desktop: таблица */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-y border-border bg-secondary/40 text-xs uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <Th>ID</Th>
                      <Th>Закрытие</Th>
                      <Th onClick={() => setSort("openedAt")}>Открыта</Th>
                      <Th onClick={() => setSort("closedAt")}>Закрыта</Th>
                      <Th onClick={() => setSort("ageDays")} align="right">
                        Срок
                      </Th>
                      <Th>Кошелёк</Th>
                      <Th>Сеть</Th>
                      <Th>Протокол</Th>
                      <Th>Тип</Th>
                      <Th>Состав</Th>
                      <Th onClick={() => setSort("depositedUsd")} align="right">
                        Депонировано
                      </Th>
                      <Th align="right">Выведено</Th>
                      <Th align="right">Награды</Th>
                      <Th onClick={() => setSort("pnlUsd")} align="right">
                        PnL
                      </Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {view.map((p) => (
                      <tr key={p.id} className="text-xs hover:bg-accent/40">
                        <td className="px-2.5 py-1.5 font-mono">{p.id}</td>
                        <td className="px-2.5 py-1.5">
                          {p.closureType === "complete" ? (
                            <Badge
                              variant="muted"
                              className="border-success/30 bg-success/10 text-[9px] text-success"
                            >
                              ✓ Полное
                            </Badge>
                          ) : (
                            <Badge
                              variant="warning"
                              className="text-[9px]"
                              title="Closure не распознан classifier (вероятно протокол не покрыт правилами). Считаем закрытой если live API не видит."
                            >
                              ⚠ Из истории
                            </Badge>
                          )}
                        </td>
                        <td className="px-2.5 py-1.5 tabular-nums whitespace-nowrap text-muted-foreground">
                          {formatDateShort(p.openedAt)}
                        </td>
                        <td className="px-2.5 py-1.5 tabular-nums whitespace-nowrap text-muted-foreground">
                          {formatDateShort(p.closedAt)}
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums">
                          {p.ageDays} дн.
                        </td>
                        <td className="px-2.5 py-1.5 truncate max-w-[120px]">
                          {p.walletName}
                        </td>
                        <td className="px-2.5 py-1.5">
                          <Badge variant="outline" className="text-[9px] uppercase">
                            {p.chain}
                          </Badge>
                        </td>
                        <td className="px-2.5 py-1.5 truncate max-w-[140px]">
                          {p.protocol.name}
                        </td>
                        <td className="px-2.5 py-1.5">
                          <Badge variant="muted" className="text-[9px]">
                            {KIND_LABEL[p.kind] ?? p.kind}
                          </Badge>
                        </td>
                        <td className="px-2.5 py-1.5 truncate max-w-[140px] text-muted-foreground">
                          {p.symbols.join(" + ")}
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums">
                          {formatUsd(p.depositedUsd, locale)}
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums">
                          {formatUsd(p.withdrawnUsd, locale)}
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums text-muted-foreground">
                          {p.claimedRewardsUsd > 0
                            ? `+${formatUsd(p.claimedRewardsUsd, locale)}`
                            : "—"}
                        </td>
                        <td
                          className={cn(
                            "px-2.5 py-1.5 text-right tabular-nums font-semibold",
                            p.pnlUsd >= 0 ? "text-success" : "text-destructive",
                          )}
                        >
                          {p.pnlUsd >= 0 ? (
                            <ArrowUpRight className="inline h-3 w-3" />
                          ) : (
                            <ArrowDownRight className="inline h-3 w-3" />
                          )}
                          {p.pnlUsd >= 0 ? "+" : ""}
                          {formatUsd(p.pnlUsd, locale)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile: карточки */}
              <ul className="md:hidden divide-y divide-border border-y border-border">
                {view.map((p) => (
                  <li key={p.id} className="px-4 py-3 text-xs">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex items-center gap-1.5 flex-wrap">
                        <span className="font-medium text-sm truncate">{p.symbols.join(" + ")}</span>
                        <Badge variant="outline" className="text-[9px] uppercase">{p.chain}</Badge>
                        <Badge variant="muted" className="text-[9px]">{KIND_LABEL[p.kind] ?? p.kind}</Badge>
                      </div>
                      <div
                        className={cn(
                          "text-right tabular-nums font-semibold shrink-0 text-sm",
                          p.pnlUsd >= 0 ? "text-success" : "text-destructive",
                        )}
                      >
                        {p.pnlUsd >= 0 ? (
                          <ArrowUpRight className="inline h-3 w-3" />
                        ) : (
                          <ArrowDownRight className="inline h-3 w-3" />
                        )}
                        {p.pnlUsd >= 0 ? "+" : ""}{formatUsd(p.pnlUsd, locale)}
                      </div>
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground truncate">
                      {p.protocol.name} · {p.walletName}
                    </div>
                    <div className="mt-1.5 flex items-center gap-1.5 text-[11px]">
                      {p.closureType === "complete" ? (
                        <Badge variant="muted" className="border-success/30 bg-success/10 text-[9px] text-success">
                          ✓ Полное
                        </Badge>
                      ) : (
                        <Badge variant="warning" className="text-[9px]">
                          ⚠ Из истории
                        </Badge>
                      )}
                      <span className="text-muted-foreground tabular-nums">
                        {formatDateShort(p.openedAt)} → {formatDateShort(p.closedAt)} · {p.ageDays} дн.
                      </span>
                    </div>
                    <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Депонировано</dt>
                        <dd className="tabular-nums">{formatUsd(p.depositedUsd, locale)}</dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Выведено</dt>
                        <dd className="tabular-nums">{formatUsd(p.withdrawnUsd, locale)}</dd>
                      </div>
                      {p.claimedRewardsUsd > 0 && (
                        <div className="flex justify-between gap-2 col-span-2">
                          <dt className="text-muted-foreground">Награды</dt>
                          <dd className="tabular-nums text-muted-foreground">
                            +{formatUsd(p.claimedRewardsUsd, locale)}
                          </dd>
                        </div>
                      )}
                    </dl>
                    <div className="mt-1 font-mono text-[10px] text-muted-foreground/70">
                      {p.id}
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Th({
  children,
  align,
  onClick,
}: {
  children: React.ReactNode;
  align?: "right";
  onClick?: () => void;
}) {
  return (
    <th
      onClick={onClick}
      className={cn(
        "px-2.5 py-2 font-medium",
        align === "right" ? "text-right" : "text-left",
        onClick && "cursor-pointer select-none hover:text-foreground",
      )}
    >
      {children}
    </th>
  );
}

function SummaryCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub: string;
  accent?: "success" | "destructive";
}) {
  return (
    <div className="rounded-md border border-border bg-card px-4 py-3">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 text-xl font-bold tabular-nums",
          accent === "success" && "text-success",
          accent === "destructive" && "text-destructive",
        )}
      >
        {value}
      </div>
      <div className="mt-0.5 text-[10px] text-muted-foreground">{sub}</div>
    </div>
  );
}
