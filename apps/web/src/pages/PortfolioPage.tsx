/**
 * Портфель — что у пользователя сейчас лежит на адресах и в протоколах.
 *
 * Источник данных — **live state** (актуальное on-chain состояние), а не
 * накопительный cost-basis из истории. Поэтому числа здесь должны совпадать
 * с тем, что показывает кошелёк / DeBank / Solscan прямо сейчас.
 *
 *   - EVM: DeBank (`/v1/user/all_token_list` + `all_complex_protocol_list`).
 *   - SOL: Helius (балансы) + Jupiter (цены) + Vybe / SonarWatch (DeFi-позиции).
 *
 * Cost basis из истории операций используется только как «справочно»
 * (чтобы посчитать PnL при наведении).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Coins,
  Layers,
  PiggyBank,
  RefreshCw,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  Wallet,
  X,
} from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useLoadedWallets } from "@/components/data/LoadedWalletsProvider";
import { useT, useI18n } from "@/i18n/I18nProvider";
import { formatNumber, formatUsd, shortAddress } from "@/i18n/format";
import { buildOpenPositions } from "@/lib/portfolio/open_positions";
import { useWalletHistPrices } from "@/lib/portfolio/use_hist_prices";
import {
  weightedAvgPurchase,
  type WeightedAvg,
} from "@/lib/portfolio/cost_basis_avg";
import type { ClassifiedOp } from "@/lib/portfolio/types";
import type {
  LiveProtocolPosition,
  LiveSnapshot,
  LiveSourceStatus,
  LiveTokenBalance,
} from "@/lib/portfolio/live";
import type { SavedWallet } from "@/lib/wallets";
import { cn } from "@/lib/utils";

/* --------------------------- aggregation ---------------------------------- */

interface Aggregate {
  totals: {
    walletUsd: number;
    protocolNetUsd: number;
    protocolDebtUsd: number;
    protocolAssetUsd: number;
    lpUsd: number;
    stakingUsd: number;
  };
  tokens: LiveTokenBalance[];
  positions: LiveProtocolPosition[];
  sources: { wallet: SavedWallet; sources: LiveSourceStatus[] }[];
}

interface LoadedItem {
  wallet: SavedWallet;
  live?: LiveSnapshot;
}

function aggregate(loadedList: LoadedItem[]): Aggregate {
  const tokens: LiveTokenBalance[] = [];
  const positions: LiveProtocolPosition[] = [];
  const sources: Aggregate["sources"] = [];
  const totals = {
    walletUsd: 0,
    protocolNetUsd: 0,
    protocolDebtUsd: 0,
    protocolAssetUsd: 0,
    lpUsd: 0,
    stakingUsd: 0,
  };

  for (const { wallet, live } of loadedList) {
    if (!live) continue;
    if (live.sources) sources.push({ wallet, sources: live.sources });

    for (const t of live.tokens) {
      if (t.amount <= 0) continue;
      tokens.push(t);
      totals.walletUsd += t.usd;
    }
    for (const p of live.positions) {
      positions.push(p);
      totals.protocolNetUsd += p.netUsd;
      totals.protocolDebtUsd += p.debtUsd;
      totals.protocolAssetUsd += p.assetUsd;
      const cat = p.category.toLowerCase();
      if (cat.includes("lp") || cat.includes("liquidity") || cat.includes("yield")) {
        totals.lpUsd += p.netUsd;
      } else if (cat.includes("stak") || cat.includes("restak")) {
        totals.stakingUsd += p.netUsd;
      }
    }
  }

  tokens.sort((a, b) => b.usd - a.usd);
  positions.sort((a, b) => b.netUsd - a.netUsd);
  return { totals, tokens, positions, sources };
}

/* ================================ PAGE =================================== */

/** Период real-time-обновления портфеля. 60 сек — баланс между свежестью
 *  и API-квотой DeBank/Helius. */
const REFRESH_INTERVAL_MS = 60_000;

export function PortfolioPage(): JSX.Element {
  const t = useT();
  const { locale } = useI18n();
  const { loadedById, busyId, loadAll, newTrackers } = useLoadedWallets();

  const loadedList = useMemo(
    () =>
      Object.values(loadedById).sort((a, b) => a.loadedAt - b.loadedAt),
    [loadedById],
  );

  /* ---------------- Auto-refresh (real-time) ---------------- */

  const [autoRefresh, setAutoRefresh] = useState(true);
  const [tick, setTick] = useState(0); // меняется каждые 30s — для live "обновлено N сек назад"
  const lastRefreshAt = useMemo(() => {
    if (loadedList.length === 0) return 0;
    return Math.max(...loadedList.map((l) => l.loadedAt));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedList, tick]);

  // 1) Тикер для перерисовки "обновлено N сек назад".
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 5_000);
    return () => clearInterval(id);
  }, []);

  // 2) Сразу обновить при заходе, потом раз в REFRESH_INTERVAL_MS.
  //    Пауза, если вкладка скрыта или при ручной отписке.
  const busyRef = useRef(busyId);
  busyRef.current = busyId;

  useEffect(() => {
    if (!autoRefresh) return;
    if (loadedList.length === 0) return;
    let cancelled = false;

    async function tickRefresh() {
      if (cancelled) return;
      if (busyRef.current) return;
      if (typeof document !== "undefined" && document.hidden) return;
      await loadAll();
    }
    // Первый тик сразу.
    void tickRefresh();
    const id = setInterval(() => void tickRefresh(), REFRESH_INTERVAL_MS);
    const onVis = () => {
      if (!document.hidden) void tickRefresh();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, loadedList.length]);

  const agg = useMemo(() => aggregate(loadedList), [loadedList]);
  const { histPrices } = useWalletHistPrices(loadedList);

  const pnl = useMemo(() => {
    // UCB C5: shared LotTracker от ucb_pipeline (cross_protocol.ts) — единый
    // source of truth. Без `lotsByWallet` buildOpenPositions падал в legacy
    // CostBasisTracker → divergence с OpenPositionsPage / HomePage.
    const positions = buildOpenPositions(
      loadedList.map((l) => ({
        wallet: l.wallet,
        ops: l.ops,
        ...(l.live !== undefined && { live: l.live }),
      })),
      { histPrices, lotsByWallet: newTrackers.lotsByWallet },
    );
    let startUsd = 0;
    let currentUsd = 0;
    let counted = 0;
    for (const p of positions) {
      // Считаем PnL только там, где известна и стартовая, и текущая стоимость.
      if (p.startUsd <= 0) continue;
      if (p.currentUsd == null) continue;
      startUsd += p.startUsd;
      currentUsd += p.currentUsd;
      counted++;
    }
    const pnlUsd = currentUsd - startUsd;
    const pnlPct = startUsd > 0 ? (pnlUsd / startUsd) * 100 : 0;
    return { startUsd, currentUsd, pnlUsd, pnlPct, counted, total: positions.length };
  }, [loadedList, histPrices, newTrackers.lotsByWallet]);

  const [walletFilter, setWalletFilter] = useState<string | "all">("all");
  const [hideUnknown, setHideUnknown] = useState(true);
  const [hideDust, setHideDust] = useState(true);

  const matchesFilter = (walletId: string) =>
    walletFilter === "all" || walletId === walletFilter;

  const tokensView = agg.tokens.filter((t) => {
    if (!matchesFilter(t.walletId)) return false;
    if (hideUnknown && !t.isKnown) return false;
    if (hideDust && t.usd < 1) return false;
    return true;
  });
  const positionsView = agg.positions.filter((p) => matchesFilter(p.walletId));

  const lendingView = positionsView.filter((p) =>
    p.category.toLowerCase().includes("lend") || p.borrow.length > 0,
  );
  const lpView = positionsView.filter((p) => {
    const c = p.category.toLowerCase();
    return c.includes("lp") || c.includes("liquidity") || c.includes("yield") || c.includes("perp") || c.includes("vault");
  });
  const stakingView = positionsView.filter((p) => {
    const c = p.category.toLowerCase();
    return c.includes("stak") || c.includes("restak");
  });
  const otherPositionsView = positionsView.filter(
    (p) => !lendingView.includes(p) && !lpView.includes(p) && !stakingView.includes(p),
  );

  const noLive = loadedList.every((l) => !l.live);

  if (loadedList.length === 0) {
    return (
      <div className="mx-auto max-w-7xl space-y-6">
        <Header />
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            Нет загруженных кошельков. Добавь кошелёк в{" "}
            <a className="text-brand-cyan hover:underline" href="/registry">
              Реестре операций
            </a>
            .
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <Header
        action={
          <div className="flex items-center gap-2">
            <RefreshIndicator
              lastRefreshAt={lastRefreshAt}
              autoRefresh={autoRefresh}
              busy={Boolean(busyId)}
              onToggleAuto={() => setAutoRefresh((v) => !v)}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={Boolean(busyId)}
              onClick={() => void loadAll()}
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", busyId && "animate-spin")}
              />
              Обновить
            </Button>
          </div>
        }
      />

      {noLive && (
        <Card>
          <CardContent className="py-4 text-sm text-warning">
            Live-state ещё не загружен. Нажмите «Обновить», чтобы подтянуть
            актуальные балансы и позиции.
          </CardContent>
        </Card>
      )}

      {/* Totals */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          icon={<Wallet />}
          label="На балансе"
          value={formatUsd(agg.totals.walletUsd, locale)}
          accent="brand"
        />
        <Stat
          icon={<Layers />}
          label="В протоколах (нетто)"
          value={formatUsd(agg.totals.protocolNetUsd, locale)}
          hint={
            agg.totals.protocolDebtUsd > 0
              ? `−${formatUsd(agg.totals.protocolDebtUsd, locale)} долг`
              : undefined
          }
        />
        <Stat
          icon={<Coins />}
          label="LP / Yield"
          value={formatUsd(agg.totals.lpUsd, locale)}
        />
        <Stat
          icon={<PiggyBank />}
          label="Стейкинг"
          value={formatUsd(agg.totals.stakingUsd, locale)}
        />
      </section>

      {/* PnL по открытым позициям */}
      {pnl.counted > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {pnl.pnlUsd >= 0 ? (
                <TrendingUp className="h-4 w-4 text-success" />
              ) : (
                <TrendingDown className="h-4 w-4 text-destructive" />
              )}
              PnL по открытым позициям
              <Badge variant="muted" className="ml-2 text-[10px]">
                {pnl.counted}/{pnl.total}
              </Badge>
            </CardTitle>
            <CardDescription>
              Сумма по всем DeFi-позициям, где известна и стартовая стоимость
              (из истории операций), и текущая (из live-state протокола).
              Закрытые on-chain учтены как $0.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <PnlStat label="Стартовая стоимость" value={formatUsd(pnl.startUsd, locale)} />
            <PnlStat
              label="Текущая стоимость"
              value={formatUsd(pnl.currentUsd, locale)}
            />
            <PnlStat
              label="PnL $"
              value={`${pnl.pnlUsd >= 0 ? "+" : ""}${formatUsd(pnl.pnlUsd, locale)}`}
              accent={pnl.pnlUsd >= 0 ? "success" : "destructive"}
            />
            <PnlStat
              label="PnL %"
              value={`${pnl.pnlPct >= 0 ? "+" : ""}${pnl.pnlPct.toFixed(2)}%`}
              accent={pnl.pnlPct >= 0 ? "success" : "destructive"}
            />
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        {loadedList.length > 1 && (
          <>
            <span className="text-xs uppercase tracking-wider text-muted-foreground">
              Кошелёк:
            </span>
            <FilterChip
              active={walletFilter === "all"}
              onClick={() => setWalletFilter("all")}
              label="Все"
              count={loadedList.length}
            />
            {loadedList.map((l) => (
              <FilterChip
                key={l.wallet.id}
                active={walletFilter === l.wallet.id}
                onClick={() => setWalletFilter(l.wallet.id)}
                label={l.wallet.name}
                chain={l.wallet.chain}
              />
            ))}
            <span className="mx-2 h-4 w-px bg-border" />
          </>
        )}
        <label className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-secondary px-3 py-1 text-xs text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={hideUnknown}
            onChange={(e) => setHideUnknown(e.target.checked)}
          />
          Только верифицированные
        </label>
        <label className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-secondary px-3 py-1 text-xs text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={hideDust}
            onChange={(e) => setHideDust(e.target.checked)}
          />
          Скрыть пыль (&lt;$1)
        </label>
      </div>

      {/* Wallet balances */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-brand-cyan" />
            На балансе кошельков
            <Badge variant="muted" className="ml-2 text-[10px]">
              {tokensView.length}
            </Badge>
          </CardTitle>
          <CardDescription>
            Актуальные балансы on-chain (DeBank / Helius+Jupiter).
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {tokensView.length === 0 ? (
            <Empty />
          ) : (
            <table className="w-full text-sm">
              <thead className="border-y border-border bg-secondary/40 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <Th>Токен</Th>
                  <Th>Кошелёк</Th>
                  <Th>Сеть</Th>
                  <Th align="right">Кол-во</Th>
                  <Th align="right">Цена</Th>
                  <Th align="right">USD</Th>
                  <Th align="right">PnL</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {tokensView.map((t) => (
                  <tr
                    key={`${t.walletId}-${t.chain}-${t.tokenId}`}
                    className="hover:bg-accent/40"
                  >
                    <td className="px-4 py-2.5">
                      <span className="font-medium">{t.symbol}</span>
                      {t.isStable && (
                        <Badge variant="muted" className="ml-2 h-5 px-1.5 text-[10px]">
                          stable
                        </Badge>
                      )}
                      {!t.isKnown && (
                        <Badge variant="warning" className="ml-2 h-5 px-1.5 text-[10px]">
                          ?
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {t.walletName}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge variant="outline" className="uppercase text-[10px]">
                        {t.chain}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {formatNumber(t.amount, locale, 6)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                      {t.price != null ? formatUsd(t.price, locale) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {formatUsd(t.usd, locale)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      <PnlBadge pnlUsd={t.pnlUsd} pnlPct={t.pnlPct} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* DeFi-позиции переехали в /performance — здесь только сводка. */}
      {(lendingView.length > 0 ||
        lpView.length > 0 ||
        stakingView.length > 0 ||
        otherPositionsView.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-brand-cyan" />
              В протоколах
              <Badge variant="muted" className="ml-2 text-[10px]">
                {lendingView.length +
                  lpView.length +
                  stakingView.length +
                  otherPositionsView.length}
              </Badge>
            </CardTitle>
            <CardDescription>
              Сводка: лендинг {lendingView.length}, LP {lpView.length},
              стейкинг {stakingView.length}, прочее {otherPositionsView.length}.
              Полный лист с PnL по каждой позиции —{" "}
              <a
                href="/performance"
                className="text-brand-cyan hover:underline"
              >
                Лист открытых позиций
              </a>
              .
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* Per-wallet sources */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Источники данных</CardTitle>
          <CardDescription>
            Какие API ответили при последней синхронизации.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {agg.sources.length === 0 ? (
            <Empty />
          ) : (
            agg.sources.map(({ wallet, sources }) => (
              <div
                key={wallet.id}
                className="flex flex-wrap items-center gap-2 text-xs"
              >
                <span className="min-w-0 truncate font-medium">
                  {wallet.name}
                </span>
                <span className="font-mono text-muted-foreground">
                  {shortAddress(wallet.address, 6, 4)}
                </span>
                <span className="text-border">·</span>
                {sources.map((s) => (
                  <span
                    key={s.name}
                    className={cn(
                      "inline-flex items-center gap-1 rounded border px-2 py-0.5",
                      s.ok
                        ? "border-success/40 text-success"
                        : "border-destructive/40 text-destructive",
                    )}
                    title={s.error ?? undefined}
                  >
                    {s.ok ? (
                      <ShieldCheck className="h-3 w-3" />
                    ) : (
                      <X className="h-3 w-3" />
                    )}
                    {s.name}
                    {s.tokens != null && (
                      <span className="opacity-70">· {s.tokens}t</span>
                    )}
                    {s.positions != null && (
                      <span className="opacity-70">· {s.positions}p</span>
                    )}
                  </span>
                ))}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground">
        Источник: <span className="font-medium text-foreground">live state</span>{" "}
        (DeBank для EVM, Helius + Jupiter + Vybe / SonarWatch для Solana).
        Cost basis для PnL подтягивается из истории операций (Реестр).
      </p>
    </div>
  );
}

/* ----------------------------- subcomponents ------------------------------ */

function Header({ action }: { action?: React.ReactNode }) {
  const t = useT();
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("nav.portfolio")}
        </h1>
        <p className="text-sm text-muted-foreground">
          Что у вас лежит на балансе и в протоколах прямо сейчас — по данным
          on-chain.
        </p>
      </div>
      {action}
    </header>
  );
}

function Th({
  children,
  align,
}: {
  children: React.ReactNode;
  align?: "right";
}) {
  return (
    <th
      className={cn(
        "px-4 py-3 font-medium",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      {children}
    </th>
  );
}

function Stat({
  icon,
  label,
  value,
  hint,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  accent?: "brand";
}) {
  return (
    <Card className="relative overflow-hidden">
      {accent === "brand" && (
        <span className="pointer-events-none absolute -top-px left-6 right-6 h-px bg-brand-gradient" />
      )}
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
          <span className="text-brand-cyan [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
          {label}
        </div>
        <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
          {value}
        </div>
        {hint && <div className="text-[11px] text-warning">{hint}</div>}
      </CardContent>
    </Card>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  count,
  chain,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  chain?: SavedWallet["chain"];
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
        active
          ? "border-brand-cyan/60 bg-brand-cyan/15 text-brand-cyan"
          : "border-border bg-secondary text-muted-foreground hover:text-foreground",
      )}
    >
      {chain && (
        <span
          className={cn(
            "inline-block h-1.5 w-1.5 rounded-full",
            chain === "sol" ? "bg-[#14F195]" : "bg-brand-cyan",
          )}
        />
      )}
      {label}
      {count != null && (
        <span className="text-[10px] opacity-70">({count})</span>
      )}
    </button>
  );
}

function PositionCard({
  p,
  ops,
}: {
  p: LiveProtocolPosition;
  ops: ClassifiedOp[];
}) {
  const { locale } = useI18n();
  // Для каждого supply-токена считаем средневзвешенную покупочную цену
  // через стейбл-парирование внутри swap'ов (см. cost_basis_avg.ts).
  const supplyEnriched = p.supply.map((s) => {
    const avg = weightedAvgPurchase(ops, s.symbol);
    return { line: s, avg };
  });
  return (
    <div className="rounded-md border border-border bg-secondary/30 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-medium">
            {p.protocolName}{" "}
            <span className="text-xs text-muted-foreground">· {p.itemName}</span>
          </div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {p.chain} · {p.walletName}
            {p.healthRate != null && (
              <span className="ml-2 text-warning">
                HR {p.healthRate.toFixed(2)}
              </span>
            )}
          </div>
        </div>
        <div className="text-right">
          <div className="font-medium tabular-nums">
            {formatUsd(p.netUsd, locale)}
          </div>
          {p.debtUsd > 0 && (
            <div className="text-[11px] text-destructive tabular-nums">
              −{formatUsd(p.debtUsd, locale)}
            </div>
          )}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <SupplyLines lines={supplyEnriched} />
        <SubLines title="Заём (debt)" lines={p.borrow} color="destructive" />
      </div>
      {p.rewards.length > 0 && (
        <div className="mt-3">
          <SubLines title="Награды" lines={p.rewards} color="success" />
        </div>
      )}
    </div>
  );
}

/**
 * Расширенный SubLines для supply: показывает средневзвешенную цену покупки
 * актива по истории + PnL ($/%).
 */
function SupplyLines({
  lines,
}: {
  lines: {
    line: { symbol: string; amount: number; usd: number };
    avg: WeightedAvg | null;
  }[];
}) {
  const { locale } = useI18n();
  if (lines.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">
        Внесено (supply)
      </div>
      <ul className="space-y-2">
        {lines.map(({ line: l, avg }, i) => {
          const currentPrice = l.amount > 0 ? l.usd / l.amount : 0;
          const pnlUsd =
            avg && currentPrice > 0
              ? (currentPrice - avg.avgUsd) * l.amount
              : null;
          const pnlPct =
            avg && avg.avgUsd > 0 && currentPrice > 0
              ? ((currentPrice - avg.avgUsd) / avg.avgUsd) * 100
              : null;
          return (
            <li
              key={`${l.symbol}-${i}`}
              className="flex flex-col gap-0.5 rounded border border-border/50 bg-card/40 px-2 py-1.5 text-sm"
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">{l.symbol}</span>
                <span className="text-right">
                  <div className="tabular-nums">
                    {formatNumber(l.amount, locale, 6)}
                  </div>
                  <div className="text-[11px] tabular-nums text-success">
                    {formatUsd(l.usd, locale)}
                  </div>
                </span>
              </div>
              {avg ? (
                <div className="grid grid-cols-3 gap-2 border-t border-border/30 pt-1 text-[10px] tabular-nums text-muted-foreground">
                  <div>
                    <div className="text-[9px] uppercase tracking-wider">
                      Ср. покупка
                    </div>
                    <div className="text-foreground">
                      {formatUsd(avg.avgUsd, locale)}
                    </div>
                    <div className="text-[9px] opacity-70">
                      из {avg.count} swap'ов
                    </div>
                  </div>
                  <div>
                    <div className="text-[9px] uppercase tracking-wider">
                      Текущая
                    </div>
                    <div className="text-foreground">
                      {formatUsd(currentPrice, locale)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[9px] uppercase tracking-wider">
                      PnL
                    </div>
                    {pnlUsd != null && pnlPct != null ? (
                      <div
                        className={cn(
                          pnlUsd >= 0 ? "text-success" : "text-destructive",
                        )}
                      >
                        {pnlUsd >= 0 ? "+" : ""}
                        {formatUsd(pnlUsd, locale)}
                        <div className="text-[9px]">
                          {pnlPct >= 0 ? "+" : ""}
                          {pnlPct.toFixed(2)}%
                        </div>
                      </div>
                    ) : (
                      <div>—</div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="border-t border-border/30 pt-1 text-[10px] text-muted-foreground">
                  Не нашёл покупок этого токена в истории операций кошелька.
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PositionRow({ p }: { p: LiveProtocolPosition }) {
  const { locale } = useI18n();
  const tokenLine = p.supply.length > 0
    ? p.supply.map((s) => s.symbol).join(" / ")
    : p.borrow.map((b) => b.symbol).join(" / ");
  return (
    <li className="flex items-center justify-between gap-3 rounded-md border border-border bg-secondary/30 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">
          {p.protocolName}{" "}
          <span className="text-muted-foreground font-normal">
            · {p.itemName}
          </span>
        </div>
        <div className="text-[11px] text-muted-foreground truncate">
          {p.chain.toUpperCase()} · {p.walletName}
          {tokenLine && ` · ${tokenLine}`}
        </div>
      </div>
      <span className="font-medium tabular-nums">
        {formatUsd(p.netUsd, locale)}
      </span>
    </li>
  );
}

function SubLines({
  title,
  lines,
  color,
}: {
  title: string;
  lines: { symbol: string; amount: number; usd: number }[];
  color: "success" | "destructive";
}) {
  const { locale } = useI18n();
  if (lines.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <ul className="space-y-1">
        {lines.map((l, i) => (
          <li
            key={`${l.symbol}-${i}`}
            className="flex items-center justify-between text-sm"
          >
            <span className="font-medium">{l.symbol}</span>
            <span className="text-right">
              <div className="tabular-nums">
                {formatNumber(l.amount, locale, 6)}
              </div>
              <div
                className={cn(
                  "text-[11px] tabular-nums",
                  color === "success" ? "text-success" : "text-destructive",
                )}
              >
                {formatUsd(l.usd, locale)}
              </div>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PnlBadge({
  pnlUsd,
  pnlPct,
}: {
  pnlUsd: number | undefined;
  pnlPct: number | undefined;
}) {
  const { locale } = useI18n();
  if (pnlUsd == null) return <span className="text-muted-foreground">—</span>;
  const pos = pnlUsd >= 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1",
        pos ? "text-success" : "text-destructive",
      )}
    >
      {pos ? (
        <TrendingUp className="h-3 w-3" />
      ) : (
        <TrendingDown className="h-3 w-3" />
      )}
      {pos ? "+" : ""}
      {formatUsd(pnlUsd, locale)}
      {pnlPct != null && (
        <span className="text-[10px] opacity-70">
          ({pos ? "+" : ""}
          {pnlPct.toFixed(1)}%)
        </span>
      )}
    </span>
  );
}

function Empty() {
  return (
    <p className="px-4 py-6 text-center text-sm text-muted-foreground">—</p>
  );
}

function RefreshIndicator({
  lastRefreshAt,
  autoRefresh,
  busy,
  onToggleAuto,
}: {
  lastRefreshAt: number;
  autoRefresh: boolean;
  busy: boolean;
  onToggleAuto: () => void;
}) {
  const ageSec = lastRefreshAt
    ? Math.max(0, Math.floor((Date.now() - lastRefreshAt) / 1000))
    : null;
  const ageLabel =
    ageSec == null
      ? "—"
      : ageSec < 60
        ? `${ageSec}с`
        : ageSec < 3600
          ? `${Math.floor(ageSec / 60)} мин`
          : `${Math.floor(ageSec / 3600)} ч`;
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-2 py-1 text-[11px] text-muted-foreground">
      <span
        className={cn(
          "inline-block h-1.5 w-1.5 rounded-full",
          busy
            ? "animate-pulse bg-brand-cyan"
            : autoRefresh
              ? "bg-success"
              : "bg-muted-foreground/40",
        )}
      />
      <span>
        {busy
          ? "обновляется…"
          : autoRefresh
            ? `live · обновлено ${ageLabel} назад`
            : `пауза · ${ageLabel} назад`}
      </span>
      <button
        type="button"
        onClick={onToggleAuto}
        className="underline-offset-2 hover:underline hover:text-foreground"
        title={autoRefresh ? "Отключить авто-обновление" : "Включить авто-обновление каждые 60с"}
      >
        {autoRefresh ? "пауза" : "вкл."}
      </button>
    </div>
  );
}

function PnlStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "success" | "destructive";
}) {
  return (
    <div className="rounded-md border border-border bg-secondary/30 p-3">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 text-xl font-semibold tabular-nums",
          accent === "success" && "text-success",
          accent === "destructive" && "text-destructive",
        )}
      >
        {value}
      </div>
    </div>
  );
}
