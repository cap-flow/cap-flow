/**
 * Детальные страницы одного кошелька — открываются в новой вкладке через
 * поиск в Topbar.
 *
 * Два режима:
 *   - `/wallet/:walletId`         — сохранённый кошелёк (`WalletDetailPage`).
 *   - `/wallet/explore?chain=&address=` — произвольный адрес для разведки
 *     (`WalletExplorePage`). Подгружает данные на лету через те же API
 *     (DeBank / Helius), но не сохраняет в `useWallets()`.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";
import {
  ArrowDownRight,
  ArrowUpRight,
  Check,
  Coins,
  Copy,
  History as HistoryIcon,
  Layers,
  RefreshCw,
  Wallet as WalletIcon,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  useLoadedWallets,
  type Loaded,
} from "@/components/data/LoadedWalletsProvider";
import { useI18n } from "@/i18n/I18nProvider";
import { formatNumber, formatUsd } from "@/i18n/format";
import { useOpAnnotations } from "@/lib/portfolio/manual_annotations";
import {
  buildOpenPositions,
  type OpenPosition,
} from "@/lib/portfolio/open_positions";
import { useWalletHistPrices } from "@/lib/portfolio/use_hist_prices";
import { computeDashboardMetrics } from "@/lib/dashboard/metrics";
import { useUsdRub } from "@/lib/dashboard/fxRate";
import { cn } from "@/lib/utils";

const CHAIN_LABEL: Record<string, string> = {
  evm: "EVM",
  sol: "Solana",
  coinstats: "CoinStats",
};

export function WalletDetailPage(): JSX.Element {
  const { walletId } = useParams<{ walletId: string }>();
  const { loadedById, load, busyId } = useLoadedWallets();

  const loaded = walletId ? loadedById[walletId] : undefined;

  if (!walletId) {
    return (
      <div className="py-20 text-center text-muted-foreground">
        Не указан walletId.
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="mx-auto max-w-3xl py-12">
        <Card>
          <CardContent className="space-y-3 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              Кошелёк <code className="font-mono">{walletId}</code> ещё не
              загружен в этом сеансе.
            </p>
            <p className="text-xs text-muted-foreground">
              Откройте дашборд в этой вкладке и подождите, пока загрузятся
              данные — затем вернитесь сюда. Также можно открыть{" "}
              <Link to="/registry" className="text-brand-cyan hover:underline">
                Реестр операций
              </Link>{" "}
              и подгрузить кошелёк.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <WalletAnalyticsView
      loaded={loaded}
      busy={busyId === loaded.wallet.id}
      onRefresh={() => void load(loaded.wallet, { full: false })}
    />
  );
}

/* -------------------------------------------------------------------------- */

/** EVM checksum-агностично, Solana — base58, 32-44 символа. */
const EVM_RE = /^0x[a-fA-F0-9]{40}$/;
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function detectAddressChain(input: string): "evm" | "sol" | null {
  const s = input.trim();
  if (EVM_RE.test(s)) return "evm";
  // Solana base58: исключаем явные EVM (с 0x).
  if (!s.startsWith("0x") && SOL_RE.test(s)) return "sol";
  return null;
}

/** Стабильный walletId для explore-режима, чтобы кэш переиспользовался. */
function exploreWalletId(chain: "evm" | "sol", address: string): string {
  return `explore::${chain}::${address.toLowerCase()}`;
}

/**
 * Страница «изучить произвольный адрес». Создаёт synthetic SavedWallet
 * (id = `explore::chain::addr`), вызывает `load()` один раз и рендерит
 * ту же аналитику, что и для сохранённого кошелька.
 */
export function WalletExplorePage(): JSX.Element {
  const [searchParams] = useSearchParams();
  const chainParam = searchParams.get("chain");
  const addressParam = searchParams.get("address")?.trim() ?? "";
  const { loadedById, load, busyId, error, clearError } = useLoadedWallets();
  const triggeredRef = useRef(false);

  const chain: "evm" | "sol" | null = useMemo(() => {
    if (chainParam === "evm" || chainParam === "sol") return chainParam;
    return detectAddressChain(addressParam);
  }, [chainParam, addressParam]);

  const walletId = chain ? exploreWalletId(chain, addressParam) : null;
  const loaded = walletId ? loadedById[walletId] : undefined;
  const busy = walletId != null && busyId === walletId;

  const syntheticWallet = useMemo(() => {
    if (!chain || !addressParam) return null;
    return {
      id: exploreWalletId(chain, addressParam),
      name: `${addressParam.slice(0, 6)}…${addressParam.slice(-4)}`,
      address: addressParam,
      chain,
      createdAt: Date.now(),
    };
  }, [chain, addressParam]);

  // Авто-загрузка при первом монтировании (если кэша нет).
  useEffect(() => {
    if (!syntheticWallet) return;
    if (loaded || busy || triggeredRef.current) return;
    triggeredRef.current = true;
    void load(syntheticWallet, { full: false });
  }, [syntheticWallet, loaded, busy, load]);

  if (!addressParam) {
    return (
      <div className="py-20 text-center text-muted-foreground">
        Не указан address.
      </div>
    );
  }

  if (!chain) {
    return (
      <div className="mx-auto max-w-3xl py-12">
        <Card>
          <CardContent className="space-y-2 py-10 text-center text-sm">
            <p className="font-medium text-destructive">
              Не удалось определить тип адреса.
            </p>
            <p className="text-xs text-muted-foreground">
              Поддерживаются EVM (0x… 40 hex) и Solana (base58, 32–44 симв.).
              Передано: <code className="font-mono">{addressParam}</code>
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="mx-auto max-w-3xl py-12">
        <Card>
          <CardContent className="space-y-3 py-10 text-center">
            <div className="flex justify-center">
              <RefreshCw className="h-6 w-6 animate-spin text-brand-cyan" />
            </div>
            <p className="text-sm font-medium">
              Загружаем данные кошелька…
            </p>
            <p className="font-mono text-[11px] text-muted-foreground break-all">
              {addressParam}
            </p>
            <p className="text-[11px] text-muted-foreground">
              Сеть: {CHAIN_LABEL[chain] ?? chain}
            </p>
            {error && (
              <div className="mx-auto max-w-sm rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
                {error}
                <button
                  type="button"
                  onClick={() => {
                    clearError();
                    triggeredRef.current = false;
                    if (syntheticWallet)
                      void load(syntheticWallet, { full: true });
                  }}
                  className="ml-2 underline"
                >
                  Повторить
                </button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <WalletAnalyticsView
      loaded={loaded}
      busy={busy}
      isExplore
      onRefresh={() =>
        syntheticWallet && void load(syntheticWallet, { full: true })
      }
    />
  );
}

/* -------------------------------------------------------------------------- */

function WalletAnalyticsView({
  loaded,
  busy,
  isExplore = false,
  onRefresh,
}: {
  loaded: Loaded;
  busy: boolean;
  isExplore?: boolean;
  onRefresh: () => void;
}) {
  const { locale } = useI18n();
  const [annotations] = useOpAnnotations();
  const { rate: usdRub } = useUsdRub();
  // UCB C5: shared `LotTracker` от ucb_pipeline (cross_protocol.ts) — единый
  // source of truth для cost basis. Раньше эта страница строила свой inline
  // CostBasisTracker через `buildCostBasisTracker` (legacy fallback в
  // `buildOpenPositions`), что давало divergence с HomePage / OpenPositionsPage
  // (которые читали `newTrackers.lotsByWallet`). Теперь все читают одно и то же.
  const { newTrackers } = useLoadedWallets();

  const { histPrices } = useWalletHistPrices([loaded]);
  const positions = useMemo<OpenPosition[]>(
    () =>
      buildOpenPositions(
        [
          {
            wallet: loaded.wallet,
            ops: loaded.ops,
            ...(loaded.live !== undefined && { live: loaded.live }),
          },
        ],
        { histPrices, lotsByWallet: newTrackers.lotsByWallet },
      ),
    [loaded, histPrices, newTrackers.lotsByWallet],
  );

  // Метрики с positions передаём — иначе computeDashboardMetrics строит
  // свои положения внутри без histPrices, и startUsd искажены.
  const metrics = useMemo(
    () =>
      computeDashboardMetrics([loaded], annotations, {
        usdRub,
        positions,
      }),
    [loaded, annotations, usdRub, positions],
  );

  const w = loaded.wallet;
  const tokens =
    loaded.live?.tokens
      .filter((t) => t.amount > 0 && t.usd >= 0.5)
      .sort((a, b) => b.usd - a.usd) ?? [];
  const totalTokenUsd = tokens.reduce((s, t) => s + t.usd, 0);

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <WalletHeaderCard
        wallet={w}
        loadedAt={loaded.loadedAt}
        busy={busy}
        onRefresh={onRefresh}
        explore={isExplore}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <KpiCard
          icon={<WalletIcon className="h-4 w-4" />}
          label="Баланс на кошельке"
          value={formatUsd(metrics?.walletUsd ?? 0, locale)}
          sub={`${tokens.length} токенов`}
        />
        <KpiCard
          icon={<Layers className="h-4 w-4" />}
          label="В протоколах"
          value={formatUsd(metrics?.protocolsAssetUsd ?? 0, locale)}
          sub={`${positions.length} позиций · долг ${formatUsd(metrics?.protocolsDebtUsd ?? 0, locale)}`}
        />
        <KpiCard
          icon={<Coins className="h-4 w-4" />}
          label="Итого активы"
          value={formatUsd(metrics?.totalAssetsUsd ?? 0, locale)}
          sub={`собств. ${formatUsd(metrics?.ownCapitalUsd ?? 0, locale)}`}
          accent
        />
      </div>

      {tokens.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <div>
              <CardTitle className="text-sm">Токены кошелька</CardTitle>
              <p className="text-[11px] text-muted-foreground">
                Σ {formatUsd(totalTokenUsd, locale)} · {tokens.length} активов
              </p>
            </div>
          </CardHeader>
          <CardContent className="px-0">
            <div className="divide-y divide-border/60">
              {tokens.map((t) => {
                const share =
                  totalTokenUsd > 0 ? (t.usd / totalTokenUsd) * 100 : 0;
                return (
                  <div
                    key={`${t.chain}-${t.tokenId}`}
                    className="flex items-center gap-3 px-4 py-2"
                  >
                    <div className="flex-[1.4] min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-semibold">
                          {t.symbol}
                        </span>
                        {t.isStable && (
                          <Badge variant="muted" className="h-4 px-1 text-[9px]">
                            stable
                          </Badge>
                        )}
                        <Badge
                          variant="outline"
                          className="h-4 px-1 text-[9px] uppercase"
                        >
                          {t.chain}
                        </Badge>
                      </div>
                    </div>
                    <div className="hidden flex-1 text-right text-[11px] tabular-nums sm:block">
                      <div className="text-foreground/90">
                        {formatNumber(t.amount, locale, 6)} {t.symbol}
                      </div>
                      {t.price != null && (
                        <div className="text-muted-foreground">
                          {formatUsd(t.price, locale)}
                        </div>
                      )}
                    </div>
                    <div className="w-28 shrink-0 text-right tabular-nums">
                      <div className="text-sm font-semibold">
                        {formatUsd(t.usd, locale)}
                      </div>
                      <div className="mt-1 flex items-center gap-1.5">
                        <div className="h-1 flex-1 overflow-hidden rounded-full bg-secondary/60">
                          <div
                            className="h-full rounded-full bg-brand-gradient"
                            style={{ width: `${Math.min(100, share)}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-muted-foreground">
                          {share.toFixed(1)}%
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {positions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Открытые позиции</CardTitle>
            <p className="text-[11px] text-muted-foreground">
              {positions.length} позиций в этом кошельке
            </p>
          </CardHeader>
          <CardContent className="px-0">
            <div className="divide-y divide-border/60">
              {positions.map((p, i) => {
                const pnlUsd =
                  p.startUsd > 0
                    ? p.currentUsd + p.feesClaimedUsd - p.startUsd
                    : null;
                const pnlPct =
                  pnlUsd != null && p.startUsd > 0
                    ? (pnlUsd / p.startUsd) * 100
                    : null;
                const positive = (pnlUsd ?? 0) >= 0;
                return (
                  <div
                    key={p.id ?? i}
                    className="flex flex-wrap items-center gap-3 px-4 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-semibold">
                          {p.protocol.name}
                        </span>
                        <Badge variant="outline" className="h-4 px-1 text-[9px] uppercase">
                          {p.chain}
                        </Badge>
                        <Badge variant="muted" className="h-4 px-1 text-[9px] uppercase">
                          {p.kind}
                        </Badge>
                      </div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        {p.supplyTokens.map((t) => t.symbol).join(" + ")}
                        {p.debtTokens.length > 0 &&
                          ` ↔ ${p.debtTokens.map((t) => t.symbol).join(" + ")}`}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-bold tabular-nums">
                        {formatUsd(p.currentUsd, locale)}
                      </div>
                      {p.currentDebtUsd > 0 && (
                        <div className="text-[11px] tabular-nums text-destructive">
                          −{formatUsd(p.currentDebtUsd, locale)} долг
                        </div>
                      )}
                    </div>
                    {pnlUsd != null && pnlPct != null && (
                      <div className="text-right">
                        <div
                          className={cn(
                            "text-sm font-bold tabular-nums",
                            positive ? "text-success" : "text-destructive",
                          )}
                        >
                          {positive ? (
                            <ArrowUpRight className="inline h-3 w-3" />
                          ) : (
                            <ArrowDownRight className="inline h-3 w-3" />
                          )}
                          {positive ? "+" : ""}
                          {formatUsd(pnlUsd, locale)}
                        </div>
                        <div
                          className={cn(
                            "text-[11px] tabular-nums",
                            positive ? "text-success/80" : "text-destructive/80",
                          )}
                        >
                          {positive ? "+" : ""}
                          {pnlPct.toFixed(2)}%
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Операции</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Всего: {loaded.ops.length}
          </p>
        </CardHeader>
        <CardContent className="px-0">
          <OpsSummary ops={loaded.ops} />
          {!isExplore && (
            <div className="px-4 pt-3">
              <Link
                to={`/registry?walletId=${encodeURIComponent(w.id)}`}
                className="inline-flex items-center gap-1 text-xs text-brand-cyan hover:underline"
              >
                <HistoryIcon className="h-3.5 w-3.5" /> Открыть в Реестре операций
              </Link>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function WalletHeaderCard({
  wallet,
  loadedAt,
  busy,
  onRefresh,
  explore = false,
}: {
  wallet: { name: string; address: string; chain: string; connectionId?: string };
  loadedAt: number;
  busy: boolean;
  onRefresh: () => void;
  explore?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  function copy() {
    void navigator.clipboard.writeText(wallet.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-card p-5 shadow-lg">
      <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-brand-gradient" />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-brand-mint to-brand-cyan text-slate-900 shadow-md">
            <WalletIcon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight">
                {wallet.name}
              </h1>
              <Badge variant="outline" className="text-[10px] uppercase">
                {CHAIN_LABEL[wallet.chain] ?? wallet.chain}
              </Badge>
              {wallet.connectionId && (
                <Badge variant="muted" className="text-[10px] uppercase">
                  {wallet.connectionId}
                </Badge>
              )}
              {explore && (
                <Badge
                  variant="outline"
                  className="border-brand-cyan/40 bg-brand-cyan/10 text-[10px] uppercase text-brand-cyan"
                >
                  Explore
                </Badge>
              )}
            </div>
            <button
              type="button"
              onClick={copy}
              className="mt-1 inline-flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground transition-colors hover:text-foreground"
              title="Скопировать адрес"
            >
              <span className="break-all">{wallet.address}</span>
              {copied ? (
                <Check className="h-3 w-3 text-success" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </button>
            <div className="mt-0.5 text-[10px] text-muted-foreground">
              Обновлено: {new Date(loadedAt).toLocaleString()}
            </div>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={busy}
          className="shrink-0"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} />
          Обновить
        </Button>
      </div>
    </div>
  );
}

function KpiCard({
  icon,
  label,
  value,
  sub,
  accent = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border bg-card p-4 shadow-sm",
        accent
          ? "border-brand-cyan/30 ring-1 ring-brand-cyan/10"
          : "border-border",
      )}
    >
      {accent && (
        <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-brand-gradient" />
      )}
      <div className="flex items-center gap-2 text-muted-foreground">
        <div className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-secondary text-brand-cyan">
          {icon}
        </div>
        <span className="text-[10px] font-medium uppercase tracking-wider">
          {label}
        </span>
      </div>
      <div className="mt-2 text-2xl font-bold tabular-nums tracking-tight">
        {value}
      </div>
      {sub && (
        <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>
      )}
    </div>
  );
}

function OpsSummary({
  ops,
}: {
  ops: { type: string; time: number; status: string }[];
}) {
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const op of ops) m.set(op.type, (m.get(op.type) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [ops]);
  if (ops.length === 0)
    return (
      <p className="px-4 py-3 text-xs text-muted-foreground">Нет операций.</p>
    );
  return (
    <div className="flex flex-wrap gap-2 px-4">
      {counts.map(([type, n]) => (
        <span
          key={type}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary/40 px-2 py-1 text-[11px]"
        >
          <span className="font-medium">{type}</span>
          <span className="tabular-nums text-muted-foreground">{n}</span>
        </span>
      ))}
    </div>
  );
}
