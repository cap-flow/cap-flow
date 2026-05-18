/**
 * Дашборд CapFlow — сводная аналитика портфеля.
 *
 * Структура:
 *   1) Hero «Капитал → Активы → Результат» — единая повествовательная карточка
 *   2) Баланс на всех кошельках — таблица токенов on-chain
 *   3) Активы в проектах — раскрываемая разбивка по протоколам
 */

import { Fragment, useEffect, useMemo, useState } from "react";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Banknote,
  ChevronDown,
  Coins,
  History as HistoryIcon,
  Info,
  Landmark,
  Layers,
  List as ListIcon,
  ExternalLink,
  EyeOff,
  Plus,
  RefreshCw as RefreshIcon,
  Settings2,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { useNavigate } from "react-router-dom";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { AnimatedDonut } from "@/components/ui/AnimatedDonut";
import { Tooltip } from "@/components/ui/Tooltip";
import {
  useLoadedWallets,
  enrichTokensWithCostBasis,
  type Loaded,
} from "@/components/data/LoadedWalletsProvider";
import { buildSnapshot } from "@/lib/portfolio/reducer";
import { useT, useI18n } from "@/i18n/I18nProvider";
import { formatNumber, formatRub, formatUsd } from "@/i18n/format";
import {
  fiatSymbol,
  formatFiat,
  useOpAnnotations,
} from "@/lib/portfolio/manual_annotations";
import {
  computeDashboardMetrics,
  computePositionLendingMetrics,
  computeProtocolBorrowAggregates,
  type DashboardMetrics,
  type LendingMetrics,
  type ProtocolBorrowAggregate,
  type ProtocolBreakdown,
} from "@/lib/dashboard/metrics";
import { useUsdRub } from "@/lib/dashboard/fxRate";
import { useActiveAccount } from "@/features/accounts/hooks";
import { useCexValuation } from "@/features/cex/hooks";
import {
  useAccountSnapshot,
  useTriggerAccountRefresh,
} from "@/features/portfolio/hooks";
import type { SnapshotMetrics } from "@/features/portfolio/api";
import {
  isLendingReceipt,
  isProtocolToken,
  isStableSymbol,
  tokenFamily,
} from "@/lib/portfolio/protocols";
import {
  buildOpenPositions,
  totalAssetsOf,
  type OpenPosition,
} from "@/lib/portfolio/open_positions";
import { useWalletHistPrices } from "@/lib/portfolio/use_hist_prices";
import { useV3HistoricalPoolPrices } from "@/lib/v3/use_historical_prices";
import { useV3Positions } from "@/lib/v3/hook";
import { useV3LiquidityEvents } from "@/lib/v3/use_liquidity_events";
import { applyV3CostBasisOverride } from "@/lib/portfolio/v3_cost_basis_override";
import { applyLendingCostBasisOverride } from "@/lib/portfolio/lending_cost_basis_override";
import { useLotMethodology } from "@/lib/lot_methodology";
import {
  useAaveReserveConfigs,
  aaveReserveConfigKey,
  type AaveReserveConfigMap,
} from "@/lib/aave/use_reserve_configs";
import { useIntegrations } from "@/lib/integrations";
import {
  buildPositionTimeline,
  timelineKindLabel,
  type PositionTimelineEvent,
} from "@/lib/portfolio/position_timeline";
import type { ClassifiedOp } from "@/lib/portfolio/types";
import {
  positionOverrideKey,
  usePositionOverrides,
} from "@/lib/portfolio/position_overrides";
import {
  expandByComposition,
  normalizeCompositionKey,
  useAssetCompositions,
} from "@/lib/portfolio/asset_composition";
import { AssetCompositionDialog } from "@/components/portfolio/AssetCompositionDialog";
import { OnboardingChecklist } from "@/components/onboarding/OnboardingChecklist";
// TvlChart import kept commented for easy revert; component remains in source.
// import { TvlChart } from "@/components/portfolio/TvlChart";
import { cn } from "@/lib/utils";

/**
 * Группа в Структуре портфеля.
 *  - Все стейблы → STABLES (USDC, USDT, USD₮0, USDT0, USDC.e, GHO, DAI, …).
 *  - Все обёртки и LST → базовый актив:
 *      WETH/stETH/wstETH/weETH/eETH/rETH/cbETH/sfrxETH/ezETH/rsETH/osETH/swETH → ETH
 *      WBTC/cbBTC/tBTC → BTC
 *      WSOL/JitoSOL/mSOL/bSOL/JupSOL → SOL
 *  - Прочее (CHAOS, JUP, …) — каждый в собственной группе с символом как label.
 */
const ETH_DERIVATIVES = new Set([
  "STETH",
  "WSTETH",
  "EETH",
  "WEETH",
  "RETH",
  "CBETH",
  "SFRXETH",
  "FRXETH",
  "EZETH",
  "RSETH",
  "OSETH",
  "SWETH",
  "ANKR.E",
  "ANKRETH",
]);
const SOL_DERIVATIVES = new Set([
  "JITOSOL",
  "MSOL",
  "BSOL",
  "JUPSOL",
  "JSOL",
  "INF",
]);

function portfolioGroupOf(symbol: string): { key: string; label: string } {
  if (isStableSymbol(symbol)) return { key: "STABLES", label: "Stablecoin" };
  const fam = tokenFamily(symbol); // WETH→ETH, WBTC/CBBTC/TBTC→BTC, WSOL→SOL
  const upper = symbol
    .toUpperCase()
    .replace(/₮/g, "T")
    .replace(/\.[A-Z0-9]+$/, "");
  if (ETH_DERIVATIVES.has(upper) || fam === "ETH")
    return { key: "ETH", label: "ETH" };
  if (fam === "BTC") return { key: "BTC", label: "BTC" };
  if (SOL_DERIVATIVES.has(upper) || fam === "SOL")
    return { key: "SOL", label: "SOL" };
  return { key: fam || symbol.toUpperCase(), label: symbol };
}

/* -------------------------------------------------------------------------- */

export function HomePage(): JSX.Element {
  const { locale } = useI18n();
  const { loadedById, internalHashes } = useLoadedWallets();
  // F2: auto-redirect новых users на onboarding wizard. Один раз per device
  // (флаг в localStorage). Если user уже завершил или пропустил — не редирект.
  const homeNavigate = useNavigate();
  useEffect(() => {
    try {
      if (localStorage.getItem("capflow.onboarding.completed.v1") !== "true") {
        homeNavigate("/onboarding", { replace: true });
      }
    } catch {
      // localStorage unavailable — пропустить, не блокировать dashboard.
    }
  }, [homeNavigate]);
  const [annotations] = useOpAnnotations();
  const { rate: usdRub } = useUsdRub();
  // Server-side snapshot (worker-written hourly). Authoritative source
  // for top-level metrics (Текущий капитал, Стартовый капитал) — the
  // client-side compute from LoadedWalletsProvider stays for positions
  // and per-token breakdown until phase F6 finishes the migration.
  const primary = useActiveAccount();
  const { metrics: snapshotMetrics } = useAccountSnapshot(primary?.id);
  const triggerRefresh = useTriggerAccountRefresh(primary?.id);
  // CEX balances across all connected exchanges, valued in USD. Folded
  // into both Cap Wallet (top-right widget) and Capital Hero so the
  // dashboard's totals reflect on-chain + CEX as one capital.
  const cexValuationQ = useCexValuation();
  const cexUsd = cexValuationQ.data?.totalUsd ?? 0;

  // Rebuild snapshot с учётом internal-pairs cross-wallet. Это важно: при
  // переводе между своими кошельками cost basis не должен «съедаться» как
  // продажа+покупка по spot. После пересборки cost basis на отправителе
  // сохраняется (amount=0, cost=original), на получателе остаётся 0
  // (amount=X, cost=0). Cross-wallet aggregate даёт правильный cost.
  // Детекция internal pairs происходит автоматически в LoadedWalletsProvider.
  const loadedList = useMemo(
    () =>
      Object.values(loadedById)
        .map((l) => {
          if (internalHashes.size === 0) return l;
          const newSnapshot = buildSnapshot(
            l.wallet.id,
            l.wallet.address,
            l.ops,
            { internalHashes },
          );
          // Перенакладываем cost basis на live tokens из обновлённого snapshot.
          if (l.live) {
            const newTokens = l.live.tokens.map((t) => ({ ...t }));
            // Обнуляем enriched поля чтобы пересчёт прошёл с нуля.
            for (const t of newTokens) {
              delete (t as { costBasisUsd?: number }).costBasisUsd;
              delete (t as { costBasisAvg?: number }).costBasisAvg;
              delete (t as { pnlUsd?: number }).pnlUsd;
              delete (t as { pnlPct?: number }).pnlPct;
            }
            enrichTokensWithCostBasis(newTokens, newSnapshot);
            return {
              ...l,
              snapshot: newSnapshot,
              live: { ...l.live, tokens: newTokens },
            };
          }
          return { ...l, snapshot: newSnapshot };
        })
        .sort((a, b) => a.loadedAt - b.loadedAt),
    [loadedById, internalHashes],
  );

  const [positionOverrides] = usePositionOverrides();
  const [assetCompositions] = useAssetCompositions();
  const [compositionDialog, setCompositionDialog] = useState<
    { symbol: string; scope?: string; label?: string } | null
  >(null);
  const openCompositionDialog = (
    symbol: string,
    scope?: string,
    label?: string,
  ) =>
    setCompositionDialog({
      symbol,
      ...(scope !== undefined && { scope }),
      ...(label !== undefined && { label }),
    });

  // Hist-prices для asset-centric WAC: каждое out-движение получает
  // USD-стоимость по hist-цене на момент op'а, не current spot.
  // Универсально для всех протоколов (см. use_hist_prices.ts).
  const { histPrices } = useWalletHistPrices(loadedList);
  const integrations = useIntegrations()[0];
  const [lotMethodology] = useLotMethodology();
  const alchemyKey = (integrations.alchemyApiKey ?? "").trim();
  const etherscanKey = (integrations.etherscanApiKey ?? "").trim();
  const v3MintPoolPrices = useV3HistoricalPoolPrices(loadedList, alchemyKey);
  // V3 NFT positions + authoritative cost basis (Etherscan/slot0).
  // КРИТИЧНО: применяем тот же V3 override что в OpenPositionsPage чтобы
  // Активы в проектах / Сводка по капиталу показывали корректный startUsd
  // и Total PnL, согласованный с таблицей позиций.
  const v3PositionsHook = useV3Positions(loadedList, alchemyKey);
  const v3PositionsFlat = useMemo(() => {
    const out: import("@/lib/v3/positions").V3Position[] = [];
    for (const arr of v3PositionsHook.data.values()) for (const p of arr) out.push(p);
    return out;
  }, [v3PositionsHook.data]);
  const v3CostBasisHook = useV3LiquidityEvents(
    v3PositionsFlat,
    alchemyKey,
    etherscanKey,
  );
  // Aave V3 LT/LTV per asset — для точных per-asset цен ликвидации в
  // multi-collateral позициях (POS-007: WETH+WBTC). Без этого uniform-LT
  // приближение даёт 2-5% drift у активов с разными LT.
  const aaveReserveConfigs = useAaveReserveConfigs(loadedList, alchemyKey);

  // Строим OpenPosition[] и применяем ручные оверрайды (currentValueUsd / feesUsd)
  // — ровно так же, как делает «Лист открытых позиций». Иначе метрики (особенно
  // дивиденды) разойдутся с тем, что пользователь видит там.
  const openPositions = useMemo(() => {
    const raw = buildOpenPositions(
      loadedList.map((l) => ({
        wallet: l.wallet,
        ops: l.ops,
        ...(l.live !== undefined && { live: l.live }),
      })),
      { histPrices, v3MintPoolPrices: v3MintPoolPrices.data },
    );
    const withOverrides = raw.map((p) => {
      const symbols = p.supplyTokens.map((t) => t.symbol);
      const instanceId = p.instanceId;
      const k = positionOverrideKey({
        walletId: p.walletId,
        chain: p.chain,
        protocolId: p.protocol.id,
        symbols,
        ...(instanceId && { instanceId }),
      });
      const ov = positionOverrides[k];
      if (!ov) return p;
      const next = { ...p };
      if (ov.currentValueUsd != null && Number.isFinite(ov.currentValueUsd)) {
        next.currentUsd = ov.currentValueUsd;
      }
      if (ov.feesUsd != null && Number.isFinite(ov.feesUsd)) {
        next.feesUsd = ov.feesUsd;
        next.feesSource = next.feesSource ?? "v3_rewards";
      }
      // Каскад: lifetime fees + APR.
      next.feesLifetimeUsd = (next.feesUsd ?? 0) + next.feesClaimedUsd;
      next.feeAprLifetime =
        next.startUsd > 0 && next.ageDays && next.ageDays > 0
          ? (next.feesLifetimeUsd / next.startUsd) * (365 / next.ageDays) * 100
          : null;
      next.feeApr =
        next.feesUsd != null && next.startUsd > 0 && next.ageDays && next.ageDays > 0
          ? (next.feesUsd / next.startUsd) * (365 / next.ageDays) * 100
          : null;
      return next;
    });
    // ВАЖНО: фильтруем скрытые позиции (override.hidden=true) — иначе они
    // попадают в `computeDashboardMetrics` и портят все цифры на дашборде:
    // Сводку по капиталу, Активы в проектах, Total PnL, Структуру портфеля.
    const visible = withOverrides.filter((p) => {
      const symbols = p.supplyTokens.map((t) => t.symbol);
      const instanceId = p.instanceId;
      const k = positionOverrideKey({
        walletId: p.walletId,
        chain: p.chain,
        protocolId: p.protocol.id,
        symbols,
        ...(instanceId && { instanceId }),
      });
      return !positionOverrides[k]?.hidden;
    });
    // V3 cost basis override + Lending WAC override.
    let working: OpenPosition[] = visible;
    if (v3CostBasisHook.data.size > 0 && v3PositionsHook.data.size > 0) {
      const v3Result = applyV3CostBasisOverride(
        working,
        v3PositionsHook.data,
        v3CostBasisHook.data,
      );
      working = v3Result.positions;
    }
    // Lending FIFO lot-aware override: Стартовая $ = consumed lots cost.
    const opsByWallet = new Map<string, import("@/lib/portfolio/types").ClassifiedOp[]>();
    for (const l of loadedList) opsByWallet.set(l.wallet.id, l.ops);
    const lendingResult = applyLendingCostBasisOverride(
      working,
      opsByWallet,
      histPrices,
      lotMethodology,
    );
    return lendingResult.positions;
  }, [
    loadedList,
    positionOverrides,
    histPrices,
    v3MintPoolPrices.data,
    v3CostBasisHook.data,
    v3PositionsHook.data,
    lotMethodology,
  ]);

  const m = useMemo(
    () =>
      computeDashboardMetrics(loadedList, annotations, {
        usdRub,
        positions: openPositions,
      }),
    [loadedList, annotations, usdRub, openPositions],
  );

  // Map walletId → ops для пер-позиционных lending-метрик в карточках протоколов.
  const opsByWalletId = useMemo(() => {
    const m = new Map<string, ClassifiedOp[]>();
    for (const l of loadedList) m.set(l.wallet.id, l.ops);
    return m;
  }, [loadedList]);

  // ---- PNL на собственный капитал ----
  // Используем `startUsdEffective`: ручной startUsdAll если есть, иначе
  // derived = walletStartUsd (Σ amount × WAC) + protocolsInvestedUsd. Это
  // позволяет считать PnL даже без ручных фиат-аннотаций — мы знаем
  // средневзвешенную цену покупки каждого актива из истории операций
  // и можем сравнить с текущей рыночной ценой.
  const startEffective = m.startUsdEffective;
  const canSplitOwnCredit = startEffective > 0;

  // Что вы реально заработали на ваших деньгах = ownCapital − стартовый капитал.
  const clientPnlOwnUsd = canSplitOwnCredit ? m.ownCapitalUsd - startEffective : 0;
  const clientPnlOwnPct = canSplitOwnCredit
    ? (clientPnlOwnUsd / startEffective) * 100
    : null;

  // ---- PNL на кредитный капитал ----
  // Окупается ли использование кредита (включая стоимость заёма).
  //   creditTotalDebt = совокупный долг к возврату СЕЙЧАС:
  //     протокол.долг (= принципал + накопл. %) + ручные «кредит» пометки.
  //   creditCurrentValue: доля от текущих активов, отвечающая за кредитную
  //     часть инвестиций (proportional split). Корректно только если есть
  //     baseline (startUsd) — иначе formula распадается.
  const creditTotalDebtUsd = m.totalDebtUsd; // = протоколы (с %) + ручные
  const totalInvestedAll = startEffective + creditTotalDebtUsd;
  const creditShare =
    canSplitOwnCredit && totalInvestedAll > 0
      ? creditTotalDebtUsd / totalInvestedAll
      : 0;
  const creditCurrentValueUsd = m.totalAssetsUsd * creditShare;
  const pnlCreditUsd =
    canSplitOwnCredit && creditTotalDebtUsd > 0
      ? creditCurrentValueUsd - creditTotalDebtUsd
      : 0;
  const pnlCreditPct =
    canSplitOwnCredit && creditTotalDebtUsd > 0
      ? (pnlCreditUsd / creditTotalDebtUsd) * 100
      : null;

  // F6b slice 4: prefer server-side PNL when the client's cost-basis
  // chain (LoadedWalletsProvider → m.startUsdEffective) is empty but
  // the worker snapshot has computed it from the operations ledger.
  const pnlOwnUsd =
    clientPnlOwnUsd === 0 && typeof snapshotMetrics?.pnlOwnUsd === "number"
      ? snapshotMetrics.pnlOwnUsd
      : clientPnlOwnUsd;
  const pnlOwnPct =
    clientPnlOwnPct === null && typeof snapshotMetrics?.pnlOwnPct === "number"
      ? snapshotMetrics.pnlOwnPct
      : clientPnlOwnPct;

  // ---- PNL на общий капитал (собственный + кредитный) ----
  const clientPnlTotalUsd = clientPnlOwnUsd + pnlCreditUsd;
  const clientPnlTotalPct =
    canSplitOwnCredit && totalInvestedAll > 0
      ? (clientPnlTotalUsd / totalInvestedAll) * 100
      : null;

  // F6b slice 4: when client compute is null (no LoadedWalletsProvider
  // data) but the server snapshot has a real cost-basis-derived PNL,
  // prefer server values. The dashboard cards stay synced with what
  // the worker stored.
  const pnlTotalUsd =
    clientPnlTotalUsd === 0 && typeof snapshotMetrics?.pnlTotalUsd === "number"
      ? snapshotMetrics.pnlTotalUsd
      : clientPnlTotalUsd;
  const pnlTotalPct =
    clientPnlTotalPct === null && typeof snapshotMetrics?.pnlTotalPct === "number"
      ? snapshotMetrics.pnlTotalPct
      : clientPnlTotalPct;

  // APR — аннуализация по сроку с самой ранней пометки.
  // Минимум 30 дней до аннуализации: иначе compound-формула даёт миллионы %
  // на свежем кошельке (1/365 = 1 день → x365 умножение).
  const MIN_DAYS_FOR_APR = 30;
  const yearsSinceStart =
    m.earliestEntryMs > 0
      ? (Date.now() - m.earliestEntryMs) / (365 * 24 * 60 * 60 * 1000)
      : 0;
  const canAnnualize = yearsSinceStart * 365 >= MIN_DAYS_FOR_APR;
  const annualize = (pct: number | null): number | null => {
    if (!canAnnualize || pct == null) return null;
    const base = 1 + pct / 100;
    // При полном убытке (pct ≤ −100%) compound-формула даёт NaN.
    if (base <= 0) return null;
    return (Math.pow(base, 1 / yearsSinceStart) - 1) * 100;
  };
  // APR общий — на общий капитал (собств. + кредит).
  const aprPct = annualize(pnlTotalPct);
  // PNL_credit — НЕЗАВИСИМАЯ метрика: окупается ли использование кредита.
  // (стоимость активов, профинансированных кредитом) − совокупный долг.
  // Совокупный долг включает тело + накопленные проценты — то, что нужно
  // фактически вернуть. Если PNL_credit > 0 — кредит зарабатывает больше,
  // чем стоит обслуживать.
  const aprOwnPct = annualize(pnlOwnPct);
  const aprCreditPct = annualize(pnlCreditPct);

  // Структура портфеля по токенам (всё что есть: кошельки + supply в DeFi).
  // Группируем стейблы (USDC/USDT/GHO/...) → "STABLES", обёртки и LST →
  // базовый актив (WETH/wstETH/weETH → ETH; WBTC/cbBTC/tBTC → BTC).
  const portfolioAllocation = useMemo(() => {
    type GroupAcc = {
      key: string;
      label: string;
      usd: number;
      tokens: Map<string, number>; // symbol → usd
    };
    const groups = new Map<string, GroupAcc>();
    const addRaw = (symbol: string, usd: number) => {
      if (usd < 0.5 || !symbol) return;
      const { key, label } = portfolioGroupOf(symbol);
      const ex = groups.get(key) ?? {
        key,
        label,
        usd: 0,
        tokens: new Map(),
      };
      ex.usd += usd;
      ex.tokens.set(symbol, (ex.tokens.get(symbol) ?? 0) + usd);
      groups.set(key, ex);
    };
    // Состав активов применяется ТОЛЬКО к токенам внутри позиции
    // (где scope явно задан через positionOverrideKey). Wallet-токены не
    // разворачиваются по составу — это просто их исходный символ.
    //
    // Раньше передавался scope=undefined для wallet tokens, и
    // expandByComposition использовал global по символу — из-за этого
    // состав, заданный для одной позиции (Flash Trade), применялся ко
    // всем USDC в кошельке.
    const addPositionToken = (symbol: string, usd: number, scope: string) => {
      if (usd < 0.5 || !symbol) return;
      const expanded = expandByComposition(
        symbol,
        usd,
        assetCompositions,
        scope,
      );
      for (const e of expanded) addRaw(e.symbol, e.usd);
    };
    for (const l of loadedList) {
      if (!l.live) continue;
      for (const t of l.live.tokens) {
        if (t.amount <= 0) continue;
        // Receipt-токены (aTokens, cTokens, GM/GLV, fVLT, debt-токены) уже
        // учтены в `protocolsAssetUsd` через DeFi-позиции — иначе donut
        // double-count'ит. Их видно в Кошельке отдельной секцией «Расписки».
        if (isProtocolToken(t.symbol)) continue;
        addRaw(t.symbol, t.usd);
      }
    }
    for (const p of m.protocols) {
      for (const pos of p.positions) {
        const scope = positionOverrideKey({
          walletId: pos.walletId,
          chain: pos.chain,
          protocolId: pos.protocol.id,
          symbols: pos.supplyTokens.map((t) => t.symbol),
          ...(pos.instanceId && { instanceId: pos.instanceId }),
        });
        for (const s of pos.supplyTokens) {
          addPositionToken(s.symbol, s.currentUsd, scope);
        }
      }
    }
    // F6b slice 2: when the client compute produced no groups (typical
    // for SaaS users without LoadedWalletsProvider cache), fold the
    // server snapshot's `allocation` into the same group-by-symbol
    // structure. portfolioGroupOf() lives client-side and owns the
    // semantic grouping (ETH/WETH/wstETH → "ETH" bucket etc.); server
    // stays "raw symbol".
    if (groups.size === 0 && snapshotMetrics?.allocation) {
      for (const a of snapshotMetrics.allocation) {
        addRaw(a.symbol, a.usd);
      }
    }
    const totalFromSnapshot =
      typeof snapshotMetrics?.totalUsd === "number" && snapshotMetrics.totalUsd > 0
        ? snapshotMetrics.totalUsd
        : 0;
    const total = m.totalAssetsUsd > 0 ? m.totalAssetsUsd : totalFromSnapshot;
    return [...groups.values()]
      .map((g) => ({
        symbol: g.label,
        groupKey: g.key,
        usd: g.usd,
        share: total > 0 ? (g.usd / total) * 100 : 0,
        tokens: [...g.tokens.entries()]
          .map(([s, u]) => ({
            symbol: s,
            usd: u,
            share: total > 0 ? (u / total) * 100 : 0,
          }))
          .sort((a, b) => b.usd - a.usd),
      }))
      .sort((a, b) => b.usd - a.usd);
  }, [loadedList, m.protocols, m.totalAssetsUsd, assetCompositions, snapshotMetrics]);

  // Известные символы — для autocomplete в диалоге состава.
  const knownSymbols = useMemo(() => {
    const set = new Set<string>();
    for (const l of loadedList) {
      if (!l.live) continue;
      for (const t of l.live.tokens)
        if (t.amount > 0) set.add(normalizeCompositionKey(t.symbol));
    }
    for (const p of m.protocols)
      for (const pos of p.positions)
        for (const s of pos.supplyTokens)
          set.add(normalizeCompositionKey(s.symbol));
    return [...set].sort();
  }, [loadedList, m.protocols]);

  // Дивидендная доходность на собственный капитал.
  // yield = дивиденды / собств. капитал × 100% — «сколько % мои деньги
  // генерируют дохода» (собств. капитал = активы − долг).
  // annualized = yield × (365 / срок) — годовая прогнозная доходность.
  const dividendYieldPct =
    m.ownCapitalUsd > 0
      ? (m.dividendsTotalUsd / m.ownCapitalUsd) * 100
      : null;
  // Compound CAGR — та же формула что у aprPct/aprOwnPct/aprCreditPct.
  // Раньше здесь была simple `R × 1/years` → дивидендный yield не сводился
  // с APR, который compound, на одном экране.
  const dividendYieldAnnualizedPct = annualize(dividendYieldPct);

  // Сверка: total = wallet + protocols. Если расходится — диагностика.
  // Сверка: total = wallet + protocolsAsset (брутто), как в Открытых позициях.
  const reconciliationDelta =
    m.totalAssetsUsd - (m.walletUsd + m.protocolsAssetUsd);

  return (
    // M12: tighter mobile spacing (space-y-4 sm:space-y-6) — saves
    // ~16-24px of vertical real estate on phones across 6 sections.
    <div className="mx-auto max-w-7xl space-y-4 sm:space-y-6">
      {/* Top: PageHeader (left) + compact Cap Wallet (right, на той же строке) */}
      <div className="flex flex-col items-start gap-4 lg:flex-row lg:gap-6">
        <div className="flex-1 min-w-0">
          <PageHeader />
        </div>
        <div className="w-full shrink-0 lg:w-[300px]">
          <WalletBalancesBlock
            loadedList={loadedList}
            totalUsd={
              (m.walletUsd === 0 &&
              typeof snapshotMetrics?.totalUsd === "number" &&
              snapshotMetrics.totalUsd > 0
                ? snapshotMetrics.totalUsd
                : m.walletUsd) + cexUsd
            }
            cexUsd={cexUsd}
            cexAccounts={cexValuationQ.data?.perAccount ?? []}
            usdRub={usdRub}
            locale={locale}
            compact
            snapshotCounts={
              snapshotMetrics
                ? {
                    walletsCount: snapshotMetrics.walletsCount ?? 0,
                    chainsCount: snapshotMetrics.chainsCount ?? 0,
                  }
                : undefined
            }
          />
        </div>
      </div>

      {/* M17: onboarding checklist — auto-hides when all steps done. */}
      <OnboardingChecklist />

      {/* H17: TVL history chart — временно скрыт по запросу (2026-05-14).
          Endpoint `/v1/accounts/:id/history` работает; компонент готов и
          сохранён в `components/portfolio/TvlChart.tsx`. Чтобы вернуть —
          раскомментировать импорт + строку ниже. */}
      {/* <TvlChart /> */}

      {/* Сводка по капиталу — на всю ширину */}
      <CapitalHero
        m={m}
        usdRub={usdRub}
        snapshot={snapshotMetrics}
        cexUsd={cexUsd}
        cexUnpricedCount={cexValuationQ.data?.unpricedCount ?? 0}
        pnlTotalUsd={pnlTotalUsd}
        pnlTotalPct={pnlTotalPct}
        pnlOwnUsd={pnlOwnUsd}
        pnlOwnPct={pnlOwnPct}
        pnlCreditUsd={pnlCreditUsd}
        pnlCreditPct={pnlCreditPct}
        creditTotalDebtUsd={creditTotalDebtUsd}
        aprPct={aprPct}
        aprOwnPct={aprOwnPct}
        aprCreditPct={aprCreditPct}
        dividendYieldPct={dividendYieldPct}
        dividendYieldAnnualizedPct={dividendYieldAnnualizedPct}
        portfolioAllocation={portfolioAllocation}
        yearsSinceStart={yearsSinceStart}
        reconciliationDelta={reconciliationDelta}
        locale={locale}
      />

      {/* Активы в проектах — на всю ширину */}
      {m.protocols.length === 0 && snapshotMetrics?.protocols && snapshotMetrics.protocols.length > 0 ? (
        <SnapshotProtocolsBlock
          protocols={snapshotMetrics.protocols}
          protocolsAssetUsd={snapshotMetrics.protocolsAssetUsd ?? 0}
          protocolsDebtUsd={snapshotMetrics.totalDebtUsd ?? 0}
          locale={locale}
        />
      ) : (
        <ProtocolsBlock
          metrics={m}
          opsByWalletId={opsByWalletId}
          locale={locale}
          compositions={assetCompositions}
          onConfigureComposition={openCompositionDialog}
          aaveReserveConfigs={aaveReserveConfigs.data}
        />
      )}

      {compositionDialog && (
        <AssetCompositionDialog
          open
          symbol={compositionDialog.symbol}
          {...(compositionDialog.scope && { scope: compositionDialog.scope })}
          {...(compositionDialog.label && { scopeLabel: compositionDialog.label })}
          knownSymbols={knownSymbols}
          onClose={() => setCompositionDialog(null)}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function PageHeader() {
  const t = useT();
  return (
    <div className="pt-2">
      <p className="text-sm text-muted-foreground">{t("dashboard.welcome")}</p>
      <h1 className="text-3xl font-semibold tracking-tight">
        {t("dashboard.title.start")}{" "}
        <span className="text-brand-gradient">{t("dashboard.title.brand")}</span>{" "}
        {t("dashboard.title.end")}
      </h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        {t("dashboard.subtitle")}
      </p>
    </div>
  );
}

/* ============================== Hero ===================================== */

interface PortfolioAllocItem {
  symbol: string; // отображаемый лейбл группы
  groupKey: string; // стабильный ключ (STABLES / ETH / BTC / SOL / SYMBOL)
  usd: number;
  share: number;
  tokens: { symbol: string; usd: number; share: number }[];
}

// Брендовая палитра для donut'а: mint → cyan → blue → deep blue.
const ALLOCATION_PALETTE = [
  "#34E0B6", // brand-mint
  "#22D3EE", // brand-cyan
  "#3B82F6", // brand-blue
  "#1E40AF", // brand-deep
  "#0EA5E9", // sky-500
  "#475569", // slate — Прочее
];

function CapitalHero({
  m,
  usdRub,
  snapshot,
  cexUsd = 0,
  cexUnpricedCount = 0,
  pnlTotalUsd,
  pnlTotalPct,
  pnlOwnUsd,
  pnlOwnPct,
  pnlCreditUsd,
  pnlCreditPct,
  creditTotalDebtUsd,
  aprPct,
  aprOwnPct,
  aprCreditPct,
  dividendYieldPct,
  dividendYieldAnnualizedPct,
  portfolioAllocation,
  yearsSinceStart,
  reconciliationDelta,
  locale,
}: {
  m: DashboardMetrics;
  usdRub: number;
  snapshot: SnapshotMetrics | null;
  /** Total USD of all connected CEX accounts (Bybit, OKX, Bitget, MEXC, BingX). */
  cexUsd?: number;
  /** How many CEX assets we couldn't price (registry miss / quota). */
  cexUnpricedCount?: number;
  pnlTotalUsd: number;
  pnlTotalPct: number | null;
  pnlOwnUsd: number;
  pnlOwnPct: number | null;
  pnlCreditUsd: number;
  pnlCreditPct: number | null;
  creditTotalDebtUsd: number;
  aprPct: number | null;
  aprOwnPct: number | null;
  aprCreditPct: number | null;
  dividendYieldPct: number | null;
  dividendYieldAnnualizedPct: number | null;
  portfolioAllocation: PortfolioAllocItem[];
  yearsSinceStart: number;
  reconciliationDelta: number;
  locale: "en" | "ru";
}) {
  const positiveTotal = pnlTotalUsd >= 0;
  const positiveOwn = pnlOwnUsd >= 0;
  const positiveCredit = pnlCreditUsd >= 0;

  // Server snapshot wins over client compute when both are present. The
  // client-side LoadedWalletsProvider is being deprecated (phase F6); for
  // SaaS users with no local cache it returns 0 across the board, so we
  // fall back to the worker-written snapshot which always has fresh
  // totalUsd / costBasis from the upstream APIs.
  const snapshotTotalUsd =
    typeof snapshot?.totalUsd === "number" && snapshot.totalUsd > 0
      ? snapshot.totalUsd
      : null;
  const snapshotStartUsd =
    snapshot?.costBasis && snapshot.costBasis.length > 0
      ? snapshot.costBasis.reduce(
          (sum, cb) =>
            sum + (typeof cb.totalPaidUsd === "number" ? cb.totalPaidUsd : 0),
          0,
        )
      : null;
  // Base is on-chain (worker snapshot wins over empty client compute);
  // CEX assets are summed on top so the total reflects the user's full
  // capital (DeFi + CEX), which is what "Текущий капитал" promises.
  const onChainCurrentUsd =
    snapshotTotalUsd !== null && m.totalAssetsUsd === 0
      ? snapshotTotalUsd
      : m.totalAssetsUsd;
  const currentUsdToShow = onChainCurrentUsd + cexUsd;
  const startUsdToShow =
    snapshotStartUsd !== null && snapshotStartUsd > 0 && m.startUsdEffective === 0
      ? snapshotStartUsd
      : m.startUsdEffective;
  // F6b slice 1: own capital + debt come directly from snapshot when
  // the client compute is empty. Server-side these are derived from
  // DeBank's complex_protocol_list (asset/debt per protocol).
  const snapshotOwnCapitalUsd =
    typeof snapshot?.ownCapitalUsd === "number" ? snapshot.ownCapitalUsd : null;
  const snapshotDebtUsd =
    typeof snapshot?.totalDebtUsd === "number" ? snapshot.totalDebtUsd : null;
  // CEX = own capital (no loans on CEX in our model) so fold it in.
  const onChainOwnCapitalUsd =
    snapshotOwnCapitalUsd !== null && m.ownCapitalUsd === 0
      ? snapshotOwnCapitalUsd
      : m.ownCapitalUsd;
  const ownCapitalToShow = onChainOwnCapitalUsd + cexUsd;
  const debtToShow =
    snapshotDebtUsd !== null && m.totalDebtUsd === 0
      ? snapshotDebtUsd
      : m.totalDebtUsd;

  // Топ-5 групп + "Прочее" для donut'а.
  const allocSegments = useMemo(() => {
    const TOP = 5;
    const top = portfolioAllocation.slice(0, TOP);
    const rest = portfolioAllocation.slice(TOP);
    const items: PortfolioAllocItem[] = [...top];
    if (rest.length > 0) {
      const restUsd = rest.reduce((s, x) => s + x.usd, 0);
      const restShare = rest.reduce((s, x) => s + x.share, 0);
      // В «Прочее» сваливаем все группы как «токены» (с их группным лейблом).
      const restTokens = rest.flatMap((g) =>
        g.tokens.length > 0 ? g.tokens : [{ symbol: g.symbol, usd: g.usd, share: g.share }],
      );
      items.push({
        symbol: "Прочее",
        groupKey: "OTHER",
        usd: restUsd,
        share: restShare,
        tokens: restTokens.sort((a, b) => b.usd - a.usd),
      });
    }
    return items.map((it, i) => ({
      ...it,
      color: ALLOCATION_PALETTE[i] ?? "#475569",
    }));
  }, [portfolioAllocation]);
  const [hoveredSegment, setHoveredSegment] = useState<string | null>(null);

  return (
    <div className="relative space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-500">
      {/* Header: title + period */}
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            Сводка по капиталу
          </h2>
          <p className="text-[11px] text-muted-foreground">
            Вложил → есть сейчас → результат. Цифры на текущий момент.
          </p>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary/40 px-2.5 py-0.5 text-[10px] text-muted-foreground">
          Сегодня
        </span>
      </div>

      {/* TOP ROW — группа «Капитал»: 5 KPI описывающих СОСТОЯНИЕ капитала
          (4 капитала + газ за всё время как отдельный bucket — съеденная
          транзакциями стоимость, не относящаяся к PnL по активам). */}
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-5">
        <BigKpi
          label="Стартовый капитал"
          value={formatUsd(startUsdToShow, locale)}
          delta={
            m.startUsdAll > 0
              ? `${formatRub(m.startRub, locale)} вложено`
              : snapshotStartUsd !== null
                ? "Из server snapshot (Σ totalPaidUsd по cost basis)"
                : `WAC × текущие активы (нет ручных пометок)`
          }
          deltaPositive
          deltaIcon
          tooltip={
            m.startUsdAll > 0
              ? "Σ всех ручных пометок «куплено за фиат» в Реестре. $-эквивалент конвертируется по курсу ЦБ."
              : "Derived: Σ (amount × WAC) активов на кошельке + Σ startUsd по DeFi-позициям. Если поставить ручные fiatPurchase в Реестре — переключится на них."
          }
        />
        <BigKpi
          label="Текущий капитал"
          value={formatUsd(currentUsdToShow, locale)}
          delta={
            cexUsd > 0
              ? `≈ ${formatRub(currentUsdToShow * usdRub, locale)} · вкл. ${formatUsd(cexUsd, locale)} на CEX`
              : `≈ ${formatRub(currentUsdToShow * usdRub, locale)}`
          }
          deltaPositive
          tooltip={
            cexUsd > 0
              ? `On-chain $${onChainCurrentUsd.toFixed(2)} + CEX $${cexUsd.toFixed(2)}. CEX = балансы Bybit/OKX/Bitget/MEXC/BingX по последнему snapshot.${cexUnpricedCount > 0 ? ` ${cexUnpricedCount} актив(ов) без CoinGecko-цены не учтены.` : ""}`
              : "Σ on-chain балансов кошельков + брутто-стоимость supply во всех DeFi-позициях. Источник: server snapshot (worker, hourly cron) с fallback на клиентский compute."
          }
        />
        <BigKpi
          label="Собственный капитал"
          value={formatUsd(ownCapitalToShow, locale)}
          delta={`≈ ${formatRub(ownCapitalToShow * usdRub, locale)}`}
          deltaPositive={ownCapitalToShow >= 0}
          deltaIcon
          accent="success"
          tooltip="Текущий капитал − Совокупный долг. Что реально ваше после погашения всех займов."
        />
        <BigKpi
          label="Совокупный долг"
          value={formatUsd(debtToShow, locale)}
          delta={
            debtToShow > 0
              ? m.totalDebtUsd > 0
                ? `+${formatUsd(m.accruedInterestUsd, locale)} накопл. % · APR ${m.borrowAprPct?.toFixed(2) ?? "—"}%`
                : `≈ ${formatRub(debtToShow * usdRub, locale)}`
              : "займов нет"
          }
          deltaPositive={false}
          accent={debtToShow > 0 ? "destructive" : "muted"}
          tooltip="Σ borrow в DeFi + Σ ручных «кредит». Накопл. % = current_debt − net_borrowed × тек. цена."
        />
        <BigKpi
          label="Газ за всё время"
          value={formatUsd(m.totalGasUsd, locale)}
          delta={`≈ ${formatRub(m.totalGasUsd * usdRub, locale)}`}
          deltaPositive={false}
          accent={m.totalGasUsd > 0 ? "destructive" : "muted"}
          tooltip="Σ всех комиссий блокчейна (gas) по всем кошелькам с момента первой операции. Это «съеденные» транзакциями деньги, отдельно от PnL по активам."
        />
      </div>

      {/* MIDDLE: Структура портфеля + side cards */}
      <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-3">
        {/* Big block — 2/3. Брендовый cyan-teal gradient.
            В тёмной теме — приглушённая deep-teal версия для гармонии с фоном. */}
        <div
          className={cn(
            "relative overflow-hidden rounded-xl border p-3.5 ring-1 lg:col-span-2",
            // Light: яркий cyan-mint как кнопка «Обновить»
            "border-white/15 ring-white/10",
            "bg-gradient-to-br from-[#2DD4BF] via-[#22D3EE] to-[#06B6D4]",
            "shadow-[0_24px_48px_-20px_rgba(34,211,238,0.45),inset_0_1px_0_rgba(255,255,255,0.18),inset_0_-1px_0_rgba(0,0,0,0.15)]",
            // Dark: глубокий приглушённый teal — не давит, держит брендовую идентичность
            "dark:border-cyan-400/15 dark:ring-cyan-400/10",
            "dark:from-[#134E4A] dark:via-[#155E75] dark:to-[#0F2A35]",
            "dark:shadow-[0_24px_48px_-20px_rgba(34,211,238,0.25),inset_0_1px_0_rgba(255,255,255,0.06),inset_0_-1px_0_rgba(0,0,0,0.3)]",
          )}
        >
          {/* Тонкий top-highlight для объёма */}
          <span className="pointer-events-none absolute inset-x-4 top-0 h-px bg-white/40 dark:bg-white/15" />
          {/* Декоративные блики */}
          <span
            className="pointer-events-none absolute -left-16 -top-16 h-40 w-40 rounded-full opacity-40 blur-3xl dark:opacity-25"
            style={{
              background:
                "radial-gradient(closest-side, rgba(255,255,255,0.5), transparent)",
            }}
          />
          <div className="relative mb-4">
            <h3 className="text-sm font-bold tracking-tight text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.25)] dark:text-cyan-50 dark:drop-shadow-none">
              Структура портфеля
            </h3>
            <p className="text-[11px] text-white/80 dark:text-cyan-100/70">
              Распределение по токенам · кошельки + supply в DeFi
            </p>
          </div>

          <div className="relative grid grid-cols-1 items-center gap-5 sm:grid-cols-[170px_1fr]">
            <div className="flex justify-center">
              <div className="rounded-full bg-white/95 p-2.5 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.25)] ring-1 ring-white/60 dark:bg-slate-900/85 dark:shadow-[0_12px_32px_-12px_rgba(0,0,0,0.6)] dark:ring-cyan-400/20">
                <AnimatedDonut
                  segments={allocSegments.map((s) => ({
                    key: s.groupKey,
                    pct: s.share,
                    color: s.color,
                  }))}
                  size={160}
                  stroke={20}
                  showLabels
                  hoveredKey={hoveredSegment}
                  onHover={setHoveredSegment}
                  centerLabel={(() => {
                    const hovered = allocSegments.find(
                      (s) => s.groupKey === hoveredSegment,
                    );
                    if (hovered) {
                      return {
                        top: hovered.symbol,
                        main: formatUsd(hovered.usd, locale),
                        bottom: `${hovered.share.toFixed(1)}%`,
                      };
                    }
                    return {
                      top: "Всего активов",
                      main: formatUsd(m.totalAssetsUsd, locale),
                    };
                  })()}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              {allocSegments.map((s) => (
                <AllocationItem
                  key={s.groupKey}
                  segment={s}
                  active={hoveredSegment === s.groupKey}
                  onHover={(k) => setHoveredSegment(k)}
                  locale={locale}
                />
              ))}
            </div>
          </div>

          {/* Strategy: Stables vs Volatile */}
          <StrategyBar allocation={portfolioAllocation} locale={locale} />
        </div>

        {/* Side stats — 1/3. Сгруппированные блоки: PNL / Доходность / Дивиденды. */}
        <div className="grid grid-cols-1 gap-2.5">
          {/* Группа PNL */}
          <CompoundMetricCard
            icon={
              positiveTotal ? (
                <TrendingUp className="h-4 w-4" />
              ) : (
                <TrendingDown className="h-4 w-4" />
              )
            }
            iconBg={
              positiveTotal
                ? "bg-success/15 text-success"
                : "bg-destructive/15 text-destructive"
            }
            label="PNL на общий капитал"
            mainValue={`${pnlTotalUsd >= 0 ? "+" : ""}${formatUsd(pnlTotalUsd, locale)}`}
            mainPct={pnlTotalPct}
            mainAccent={positiveTotal ? "success" : "destructive"}
            mainTooltip="Unrealized PNL по активам (собств. + кредит). Не включает Realized PNL — он показан отдельной строкой ниже. % считается от общего инвестированного капитала."
            rows={[
              {
                label: "На собств. капитал",
                value: `${pnlOwnUsd >= 0 ? "+" : ""}${formatUsd(pnlOwnUsd, locale)}`,
                pct: pnlOwnPct,
                accent: positiveOwn ? "success" : "destructive",
                tooltip:
                  "Unrealized: что вы реально заработали на собственных вложениях (= текущий капитал − совокупный долг − стартовый капитал). Считается только по тому, что сейчас на руках.",
              },
              {
                label: "На кредит. капитал",
                value:
                  creditTotalDebtUsd > 0
                    ? `${pnlCreditUsd >= 0 ? "+" : ""}${formatUsd(pnlCreditUsd, locale)}`
                    : "—",
                pct: creditTotalDebtUsd > 0 ? pnlCreditPct : null,
                accent:
                  creditTotalDebtUsd === 0
                    ? "muted"
                    : positiveCredit
                      ? "success"
                      : "destructive",
                tooltip:
                  "Unrealized: окупается ли кредит. (стоимость активов на кредит) − совокупный долг (тело + накопл. %). Если положительно — кредит приносит больше, чем стоит.",
              },
              {
                label: "Realized (закрытые сделки)",
                value: `${m.realizedPnlUsd >= 0 ? "+" : ""}${formatUsd(m.realizedPnlUsd, locale)}`,
                pct: null,
                accent:
                  Math.abs(m.realizedPnlUsd) < 0.01
                    ? "muted"
                    : m.realizedPnlUsd >= 0
                      ? "success"
                      : "destructive",
                tooltip:
                  "Σ realized PnL по всем закрытым сделкам: при swap'е, продаже за стейбл, выводе на CEX. Считается как (USD-стоимость out-движения) − (WAC × amount). Включает депег-потери на стейблах.",
              },
            ]}
          />

          {/* Группа Доходность APR */}
          <CompoundMetricCard
            icon={<TrendingUp className="h-4 w-4" />}
            iconBg="bg-brand-cyan/15 text-brand-cyan"
            label="Доходность APR"
            mainValue={
              aprPct != null
                ? `${aprPct >= 0 ? "+" : ""}${aprPct.toFixed(2)}%`
                : "—"
            }
            mainAccent={aprPct != null && aprPct >= 0 ? "success" : "destructive"}
            mainTooltip={
              yearsSinceStart > 0
                ? `APR на общий капитал (собств. + кредит). Аннуализация (1 + R)^(1 / ${yearsSinceStart.toFixed(2)} лет) − 1, где R — PNL на общий капитал %.`
                : "Нет даты входа — поставьте пометку «куплено за фиат» в Реестре."
            }
            rows={[
              {
                label: "На собств. капитал",
                value:
                  aprOwnPct != null
                    ? `${aprOwnPct >= 0 ? "+" : ""}${aprOwnPct.toFixed(2)}%`
                    : "—",
                accent:
                  aprOwnPct != null
                    ? aprOwnPct >= 0
                      ? "success"
                      : "destructive"
                    : "muted",
                tooltip: "Аннуализированная доходность на собств. капитал.",
              },
              {
                label: "На кредит. капитал",
                value:
                  creditTotalDebtUsd > 0 && aprCreditPct != null
                    ? `${aprCreditPct >= 0 ? "+" : ""}${aprCreditPct.toFixed(2)}%`
                    : "—",
                accent:
                  creditTotalDebtUsd === 0 || aprCreditPct == null
                    ? "muted"
                    : aprCreditPct >= 0
                      ? "success"
                      : "destructive",
                tooltip: "Аннуализированная доходность на кредитный капитал.",
              },
            ]}
          />

          {/* Группа Дивиденды */}
          <CompoundMetricCard
            icon={<Coins className="h-4 w-4" />}
            iconBg="bg-brand-mint/15 text-brand-mint"
            label="Дивиденды"
            mainValue={formatUsd(m.dividendsTotalUsd, locale)}
            mainAccent="success"
            mainTooltip="Σ supply-yield + LP fees + rewards по позициям. Pending + claimed."
            rows={[
              {
                label: "Доходность на собств.",
                value:
                  dividendYieldAnnualizedPct != null
                    ? `${dividendYieldAnnualizedPct.toFixed(2)}% APR`
                    : "—",
                accent: "success",
                tooltip:
                  "Дивиденды / собств. капитал × 100% × (1 / срок) — годовой yield на собств. капитал.",
              },
              {
                label: "Pending / Claimed",
                value: `${formatUsd(m.dividendsPendingUsd, locale)} / ${formatUsd(m.dividendsClaimedUsd, locale)}`,
                accent: "muted",
                tooltip:
                  "Pending — ещё внутри позиций (не выведены на кошелёк). Claimed — уже сняты через claim_rewards.",
              },
            ]}
          />
        </div>
      </div>

      {/* Diagnostic */}
      {Math.abs(reconciliationDelta) > 0.5 && (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-warning">
          Расхождение в сверке: total ≠ wallets + protocols (Δ ={" "}
          {formatUsd(reconciliationDelta, locale)}). Нажмите «Обновить» в
          Реестре.
        </div>
      )}
    </div>
  );
}

function BigKpi({
  label,
  value,
  delta,
  deltaPositive,
  deltaIcon,
  accent,
  tooltip,
}: {
  label: string;
  value: string;
  delta?: string;
  deltaPositive?: boolean;
  deltaIcon?: boolean;
  accent?: "success" | "destructive" | "muted";
  tooltip?: string;
}) {
  const valueCls =
    accent === "success"
      ? "text-success"
      : accent === "destructive"
        ? "text-destructive"
        : "text-foreground";
  return (
    <div className="group relative overflow-hidden rounded-xl border border-border bg-card/60 p-3.5 transition-all duration-300 hover:-translate-y-0.5 hover:border-brand-cyan/40">
      <span className="pointer-events-none absolute inset-x-3 -top-px h-px bg-brand-gradient opacity-0 transition-opacity group-hover:opacity-80" />
      <div className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
        {tooltip && (
          <Tooltip
            maxWidth={280}
            content={
              <div className="text-[11px] text-foreground/90">{tooltip}</div>
            }
          >
            <span className="ml-auto cursor-help text-muted-foreground/70 hover:text-foreground">
              <Info className="h-3 w-3" />
            </span>
          </Tooltip>
        )}
      </div>
      <div
        className={cn(
          "mt-1.5 text-xl font-semibold tabular-nums tracking-tight sm:text-2xl",
          valueCls,
        )}
      >
        {value}
      </div>
      {delta && (
        <div className="mt-1.5 flex items-center gap-1 text-[11px]">
          {deltaIcon && (
            <span
              className={cn(
                "inline-flex h-3.5 w-3.5 items-center justify-center",
                deltaPositive ? "text-success" : "text-destructive",
              )}
            >
              {deltaPositive ? (
                <ArrowUpRight className="h-3 w-3" />
              ) : (
                <ArrowDownRight className="h-3 w-3" />
              )}
            </span>
          )}
          <span
            className={cn(
              "font-medium tabular-nums",
              deltaPositive
                ? accent === "destructive"
                  ? "text-destructive"
                  : "text-success"
                : "text-muted-foreground",
            )}
          >
            {delta}
          </span>
        </div>
      )}
    </div>
  );
}

function AllocationItem({
  segment,
  active,
  onHover,
  locale,
}: {
  segment: PortfolioAllocItem & { color: string };
  active: boolean;
  onHover: (k: string | null) => void;
  locale: "en" | "ru";
}) {
  const hasMultiple = segment.tokens.length > 1;
  return (
    <div
      className="group/alloc relative"
      onMouseEnter={() => onHover(segment.groupKey)}
      onMouseLeave={() => onHover(null)}
    >
      <div
        className={cn(
          "flex items-center gap-2 rounded-md border px-2.5 py-1 shadow-sm backdrop-blur-sm transition-all",
          // Light mode — белая карточка
          "border-white/40 bg-white/90",
          // Dark mode — тёмная стеклянная карточка
          "dark:border-cyan-400/15 dark:bg-slate-900/55",
          active && "border-white bg-white shadow-md",
          active && "dark:border-cyan-400/40 dark:bg-slate-900/75",
          !active && "group-hover/alloc:border-white/70 group-hover/alloc:bg-white",
          !active &&
            "dark:group-hover/alloc:border-cyan-400/30 dark:group-hover/alloc:bg-slate-900/70",
        )}
      >
        {/* Левая часть: точка + символ + бейдж количества */}
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: segment.color }}
          />
          <span className="truncate text-[12px] font-semibold text-slate-900 dark:text-white">
            {segment.symbol}
          </span>
          {hasMultiple && (
            <span className="rounded-full bg-slate-100 px-1 py-px text-[9px] font-bold tabular-nums leading-none text-slate-600 dark:bg-white/10 dark:text-slate-300">
              {segment.tokens.length}
            </span>
          )}
        </span>

        {/* Правая часть: $ значение + % */}
        <span className="flex shrink-0 items-baseline gap-1.5 tabular-nums">
          <span className="text-[12px] font-bold text-slate-900 dark:text-white">
            {formatUsd(segment.usd, locale)}
          </span>
          <span className="min-w-[2.5rem] text-right text-[10px] font-semibold text-slate-500 dark:text-slate-400">
            {segment.share.toFixed(1)}%
          </span>
        </span>
      </div>
      {/* Dropdown с underlying-токенами (показывается при наведении на эту
          строку или на соответствующий сегмент donut'а — управляется через
          `active` prop, который меняется в обоих случаях). */}
      {hasMultiple && (
        <div
          className={cn(
            "absolute left-0 right-0 top-full z-30 mt-1 origin-top rounded-lg border bg-popover/95 p-2 shadow-lg backdrop-blur-sm transition-all duration-150",
            "border-slate-300 dark:border-cyan-400/30",
            active
              ? "visible scale-100 opacity-100"
              : "invisible scale-95 opacity-0",
          )}
        >
          <div className="mb-1 flex items-center justify-between gap-2 border-b border-border/40 pb-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
            <span>{segment.symbol} · подробно</span>
            <span>{segment.tokens.length} токенов</span>
          </div>
          <ul className="space-y-0.5">
            {segment.tokens.map((t) => (
              <li
                key={t.symbol}
                className="flex items-center justify-between gap-2 rounded px-1.5 py-0.5 text-[11px] hover:bg-secondary/60"
              >
                <span className="truncate font-medium">{t.symbol}</span>
                <span className="flex shrink-0 items-baseline gap-1.5 tabular-nums">
                  <span className="font-semibold">
                    {formatUsd(t.usd, locale)}
                  </span>
                  <span className="text-[9px] text-muted-foreground">
                    {t.share.toFixed(2)}%
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function StrategyBar({
  allocation,
  locale,
}: {
  allocation: PortfolioAllocItem[];
  locale: "en" | "ru";
}) {
  const stables = allocation.find((g) => g.groupKey === "STABLES");
  const stableUsd = stables?.usd ?? 0;
  const totalUsd = allocation.reduce((s, g) => s + g.usd, 0);
  const volatileUsd = totalUsd - stableUsd;
  const stablePct = totalUsd > 0 ? (stableUsd / totalUsd) * 100 : 0;
  const volatilePct = 100 - stablePct;

  // Стратегия по доле стейблкоинов:
  //   ≥ 70% — консервативный (защита капитала, минимум волатильности)
  //   40–70% — умеренный (баланс роста и защиты)
  //   < 40% — агрессивный (высокий потенциал и риск)
  const strategy =
    stablePct >= 70
      ? {
          label: "Консервативный",
          color: "text-success border-success/40 bg-success/10",
          desc: "Защита капитала, низкая волатильность",
        }
      : stablePct >= 40
        ? {
            label: "Умеренный",
            color: "text-brand-cyan border-brand-cyan/40 bg-brand-cyan/10",
            desc: "Баланс роста и защиты",
          }
        : {
            label: "Агрессивный",
            color: "text-warning border-warning/40 bg-warning/10",
            desc: "Высокий потенциал и риск",
          };

  // Бейдж стратегии: пастельная заливка в светлой теме, насыщенный glow в тёмной.
  const strategyChip =
    stablePct >= 70
      ? "bg-emerald-100 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30"
      : stablePct >= 40
        ? "bg-cyan-100 text-cyan-700 ring-cyan-200 dark:bg-cyan-500/15 dark:text-cyan-300 dark:ring-cyan-500/30"
        : "bg-amber-100 text-amber-700 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30";
  return (
    <div className="relative mt-4 rounded-lg border border-white/60 bg-white/90 px-3 py-2.5 shadow-sm backdrop-blur-sm dark:border-cyan-400/15 dark:bg-slate-900/55">
      {/* Header: title + strategy chip */}
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400">
          Стратегия портфеля
          <Tooltip
            maxWidth={300}
            content={
              <div className="text-[11px] text-foreground/90">
                Определяется по доле стейблкоинов:{" "}
                <span className="text-success">≥ 70% — консервативный</span>,{" "}
                <span className="text-brand-cyan">40–70% — умеренный</span>,{" "}
                <span className="text-warning">{"<"} 40% — агрессивный</span>.
              </div>
            }
          >
            <span className="cursor-help text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200">
              <Info className="h-3 w-3" />
            </span>
          </Tooltip>
        </span>
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-bold ring-1",
            strategyChip,
          )}
        >
          {strategy.label}
        </span>
      </div>

      {/* Прогресс-бар: стейблы (мятный) vs волатильные (синий) */}
      <div className="mt-2.5 flex h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
        <div
          className="h-full bg-gradient-to-r from-emerald-400 to-emerald-300 transition-all duration-700"
          style={{ width: `${stablePct}%` }}
        />
        <div
          className="h-full bg-gradient-to-r from-blue-500 to-indigo-600 transition-all duration-700"
          style={{ width: `${volatilePct}%` }}
        />
      </div>

      {/* Легенда */}
      <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-slate-900 dark:text-white">
              Стейблы
            </div>
            <div className="tabular-nums text-slate-500 dark:text-slate-400">
              {stablePct.toFixed(1)}% · {formatUsd(stableUsd, locale)}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full bg-blue-500" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-slate-900 dark:text-white">
              Волатильные
            </div>
            <div className="tabular-nums text-slate-500 dark:text-slate-400">
              {volatilePct.toFixed(1)}% · {formatUsd(volatileUsd, locale)}
            </div>
          </div>
        </div>
      </div>

      {/* Описание стратегии */}
      <div className="mt-2 border-t border-slate-200 pt-1.5 text-[10px] italic text-slate-500 dark:border-slate-800 dark:text-slate-400">
        {strategy.desc}
      </div>
    </div>
  );
}

function CompoundMetricCard({
  icon,
  iconBg,
  label,
  mainValue,
  mainPct,
  mainAccent,
  mainTooltip,
  rows,
}: {
  icon: React.ReactNode;
  iconBg: string;
  label: string;
  mainValue: string;
  mainPct?: number | null;
  mainAccent: "success" | "destructive" | "muted";
  mainTooltip?: string;
  rows: Array<{
    label: string;
    value: string;
    pct?: number | null;
    accent: "success" | "destructive" | "muted";
    tooltip?: string;
  }>;
}) {
  const mainCls =
    mainAccent === "success"
      ? "text-success"
      : mainAccent === "destructive"
        ? "text-destructive"
        : "text-foreground";
  return (
    <div className="rounded-xl border border-border bg-card/60 p-3 transition-all duration-300 hover:border-brand-cyan/40">
      {/* Header */}
      <div className="flex items-center gap-2">
        <div
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-full [&_svg]:h-3 [&_svg]:w-3",
            iconBg,
          )}
        >
          {icon}
        </div>
        <span className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
          {mainTooltip && (
            <Tooltip
              maxWidth={280}
              content={
                <div className="text-[11px] text-foreground/90">{mainTooltip}</div>
              }
            >
              <span className="cursor-help text-muted-foreground/70 hover:text-foreground">
                <Info className="h-3 w-3" />
              </span>
            </Tooltip>
          )}
        </span>
      </div>

      {/* Main value */}
      <div className="mt-1 flex items-baseline gap-1.5">
        <span
          className={cn(
            "text-lg font-bold tabular-nums tracking-tight",
            mainCls,
          )}
        >
          {mainValue}
        </span>
        {mainPct != null && (
          <span
            className={cn(
              "text-[10px] font-semibold tabular-nums",
              mainAccent === "success"
                ? "text-success/80"
                : mainAccent === "destructive"
                  ? "text-destructive/80"
                  : "text-muted-foreground",
            )}
          >
            ({mainPct >= 0 ? "+" : ""}
            {mainPct.toFixed(2)}%)
          </span>
        )}
      </div>

      {/* Sub rows */}
      <div className="mt-2 space-y-1 border-t border-border/40 pt-2">
        {rows.map((r, i) => (
          <div
            key={i}
            className="flex items-baseline justify-between gap-2 text-[10px]"
          >
            <span className="inline-flex items-center gap-1 truncate text-muted-foreground">
              <span className="truncate">{r.label}</span>
              {r.tooltip && (
                <Tooltip
                  maxWidth={260}
                  content={
                    <div className="text-[11px] text-foreground/90">{r.tooltip}</div>
                  }
                >
                  <span className="shrink-0 cursor-help text-muted-foreground/70 hover:text-foreground">
                    <Info className="h-2.5 w-2.5" />
                  </span>
                </Tooltip>
              )}
            </span>
            <span className="flex shrink-0 items-baseline gap-1 tabular-nums">
              <span
                className={cn(
                  "font-semibold",
                  r.accent === "success"
                    ? "text-success"
                    : r.accent === "destructive"
                      ? "text-destructive"
                      : "text-foreground",
                )}
              >
                {r.value}
              </span>
              {r.pct != null && (
                <span
                  className={cn(
                    "text-[9px] opacity-80",
                    r.accent === "success"
                      ? "text-success"
                      : r.accent === "destructive"
                        ? "text-destructive"
                        : "text-muted-foreground",
                  )}
                >
                  ({r.pct >= 0 ? "+" : ""}
                  {r.pct.toFixed(2)}%)
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SideStatCard({
  icon,
  iconBg,
  label,
  value,
  sub,
  deltaPositive,
  note,
}: {
  icon: React.ReactNode;
  iconBg: string;
  label: string;
  value: string;
  sub?: string;
  deltaPositive?: boolean;
  note?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card/60 p-3 transition-all duration-300 hover:-translate-y-0.5 hover:border-brand-cyan/40">
      <div className="flex items-center gap-2">
        <div
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-full [&_svg]:h-3 [&_svg]:w-3",
            iconBg,
          )}
        >
          {icon}
        </div>
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </div>
      <div className="mt-1.5 flex items-baseline gap-1.5">
        <span className="text-lg font-semibold tabular-nums tracking-tight">
          {value}
        </span>
        {sub && (
          <span
            className={cn(
              "rounded-md px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
              deltaPositive
                ? "bg-success/15 text-success"
                : "bg-destructive/15 text-destructive",
            )}
          >
            {sub}
          </span>
        )}
      </div>
      {note && (
        <div className="mt-1 text-[10px] leading-snug text-muted-foreground">
          {note}
        </div>
      )}
    </div>
  );
}

function OwnCapitalCard({
  ownUsd,
  ownRub,
  pnlRub,
  pnlPct,
  positive,
  locale,
}: {
  ownUsd: number;
  ownRub: number;
  pnlRub: number;
  pnlPct: number | null;
  positive: boolean;
  locale: "en" | "ru";
}) {
  return (
    <div className="rounded-lg border border-border bg-card/40 px-3 py-2.5 transition-colors hover:bg-card/70">
      <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Собственный капитал
        <Tooltip
          maxWidth={260}
          content={
            <div className="text-[11px] text-foreground/90">
              всего активов − совокупный долг. Снизу — PNL ₽ от вложенных
              (PNL × текущий курс ЦБ).
            </div>
          }
        >
          <span className="ml-auto cursor-help text-muted-foreground/70 hover:text-foreground">
            <Info className="h-3 w-3" />
          </span>
        </Tooltip>
      </div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0">
        <span className="text-base font-semibold tabular-nums">
          {formatUsd(ownUsd, locale)}
        </span>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          ≈ {formatRub(ownRub, locale)}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 border-t border-border/40 pt-1 text-[10px]">
        <span className="font-medium uppercase tracking-wider text-muted-foreground">
          PNL ₽ от вложенных
        </span>
        <span
          className={cn(
            "tabular-nums font-semibold",
            positive ? "text-success" : "text-destructive",
          )}
        >
          {pnlRub >= 0 ? "+" : ""}
          {formatRub(pnlRub, locale)}
          {pnlPct != null && (
            <span className="ml-1 font-medium opacity-80">
              ({pnlPct >= 0 ? "+" : ""}
              {pnlPct.toFixed(2)}%)
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

function SmallStatCard({
  label,
  value,
  sub,
  accent,
  tooltip,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "success" | "destructive" | "muted";
  tooltip?: string;
}) {
  const cls =
    accent === "success"
      ? "text-success"
      : accent === "destructive"
        ? "text-destructive"
        : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-card/40 px-3 py-2.5 transition-colors hover:bg-card/70">
      <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
        {tooltip && (
          <Tooltip
            maxWidth={260}
            content={
              <div className="text-[11px] text-foreground/90">{tooltip}</div>
            }
          >
            <span className="ml-auto cursor-help text-muted-foreground/70 hover:text-foreground">
              <Info className="h-3 w-3" />
            </span>
          </Tooltip>
        )}
      </div>
      <div
        className={cn(
          "mt-0.5 text-base font-semibold tabular-nums tracking-tight",
          cls,
        )}
      >
        {value}
      </div>
      {sub && (
        <div
          className={cn(
            "text-[10px] tabular-nums",
            accent === "success"
              ? "text-success/80"
              : accent === "destructive"
                ? "text-destructive/80"
                : "text-muted-foreground",
          )}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

function FlowArrow() {
  return (
    <div className="hidden items-center justify-center text-brand-cyan/70 lg:flex">
      <ArrowRight className="h-5 w-5 animate-pulse" />
    </div>
  );
}

function BreakdownStage({
  accent,
  icon,
  title,
  mainLabel,
  mainValueUsd,
  mainValueRub,
  tooltip,
  breakdown,
  locale,
}: {
  accent: "emerald" | "brand" | "success" | "destructive";
  icon: React.ReactNode;
  title: string;
  mainLabel: string;
  mainValueUsd: number;
  mainValueRub: number;
  tooltip?: string;
  breakdown: {
    icon?: React.ReactNode;
    label: string;
    valueUsd: number;
    valueRub: number;
    pnlRub?: number;
    pnlPct?: number | null;
    tooltip?: string;
  }[];
  locale: "en" | "ru";
}) {
  const ring =
    accent === "emerald"
      ? "border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 via-card to-card"
      : accent === "success"
        ? "border-success/30 bg-gradient-to-br from-success/10 via-card to-card"
        : accent === "destructive"
          ? "border-destructive/30 bg-gradient-to-br from-destructive/10 via-card to-card"
          : "border-brand-cyan/30 bg-gradient-to-br from-brand-cyan/10 via-card to-card";
  const iconCls =
    accent === "brand"
      ? "border-brand-cyan/40 bg-brand-cyan/15 text-brand-cyan"
      : accent === "emerald"
        ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-400"
        : accent === "success"
          ? "border-success/40 bg-success/15 text-success"
          : "border-destructive/40 bg-destructive/15 text-destructive";
  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-lg border p-3 transition-all duration-300 hover:-translate-y-0.5",
        ring,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-md border [&_svg]:h-3 [&_svg]:w-3",
            iconCls,
          )}
        >
          {icon}
        </div>
        <span className="inline-flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
          {tooltip && (
            <Tooltip
              maxWidth={280}
              content={
                <div className="text-[11px] text-foreground/90">{tooltip}</div>
              }
            >
              <span className="cursor-help text-muted-foreground/70 hover:text-foreground">
                <Info className="h-3 w-3" />
              </span>
            </Tooltip>
          )}
        </span>
      </div>

      {/* Main: всего активов $ */}
      <div className="mt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {mainLabel}
      </div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums tracking-tight">
        <AnimatedNumber
          value={mainValueUsd}
          format={(v) => formatUsd(v, locale)}
        />
      </div>
      <div className="text-[11px] tabular-nums text-muted-foreground">
        ≈{" "}
        <AnimatedNumber
          value={mainValueRub}
          format={(v) => formatRub(v, locale)}
          className="text-foreground/80"
        />
      </div>

      {/* Breakdown rows */}
      <div className="mt-2 space-y-1.5 border-t border-border/40 pt-1.5">
        {breakdown.map((b, i) => (
          <div key={i} className="rounded-md bg-card/50 px-2 py-1.5">
            <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {b.icon}
              {b.label}
              {b.tooltip && (
                <Tooltip
                  maxWidth={260}
                  content={
                    <div className="text-[11px] text-foreground/90">
                      {b.tooltip}
                    </div>
                  }
                >
                  <span className="cursor-help text-muted-foreground/70 hover:text-foreground">
                    <Info className="h-3 w-3" />
                  </span>
                </Tooltip>
              )}
            </div>
            <div className="mt-0.5 grid grid-cols-2 items-baseline gap-2">
              <div className="text-sm font-semibold tabular-nums">
                <AnimatedNumber
                  value={b.valueUsd}
                  format={(v) => formatUsd(v, locale)}
                />
              </div>
              <div className="text-right text-[11px] tabular-nums text-muted-foreground">
                <AnimatedNumber
                  value={b.valueRub}
                  format={(v) => formatRub(v, locale)}
                  className="text-foreground/80"
                />
              </div>
            </div>
            {b.pnlRub != null && (
              <div className="mt-0.5 flex items-baseline justify-between text-[9px] tabular-nums">
                <span className="uppercase tracking-wider text-muted-foreground">
                  PNL ₽
                </span>
                <span
                  className={cn(
                    b.pnlRub >= 0 ? "text-success" : "text-destructive",
                  )}
                >
                  {b.pnlRub >= 0 ? "+" : ""}
                  {formatRub(b.pnlRub, locale)}
                  {b.pnlPct != null && (
                    <span className="ml-1 opacity-80">
                      ({b.pnlPct >= 0 ? "+" : ""}
                      {b.pnlPct.toFixed(2)}%)
                    </span>
                  )}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Stage({
  accent,
  icon,
  title,
  mainLabel,
  mainValue,
  subLabel,
  subValue,
  footer,
  tooltip,
  children,
  centered,
}: {
  accent: "emerald" | "brand" | "success" | "destructive";
  icon: React.ReactNode;
  title: string;
  mainLabel: string;
  mainValue: React.ReactNode;
  subLabel: React.ReactNode;
  subValue: React.ReactNode;
  footer?: string;
  tooltip?: string;
  children?: React.ReactNode;
  centered?: boolean;
}) {
  const ring =
    accent === "emerald"
      ? "border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 via-card to-card"
      : accent === "success"
        ? "border-success/30 bg-gradient-to-br from-success/10 via-card to-card"
        : accent === "destructive"
          ? "border-destructive/30 bg-gradient-to-br from-destructive/10 via-card to-card"
          : "border-brand-cyan/30 bg-gradient-to-br from-brand-cyan/10 via-card to-card";
  const iconCls =
    accent === "emerald"
      ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-400"
      : accent === "success"
        ? "border-success/40 bg-success/15 text-success"
        : accent === "destructive"
          ? "border-destructive/40 bg-destructive/15 text-destructive"
          : "border-brand-cyan/40 bg-brand-cyan/15 text-brand-cyan";
  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-lg border p-3 transition-all duration-300 hover:-translate-y-0.5",
        ring,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-md border [&_svg]:h-3 [&_svg]:w-3",
            iconCls,
          )}
        >
          {icon}
        </div>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1">
          {title}
          {tooltip && (
            <Tooltip
              maxWidth={280}
              content={
                <div className="text-[11px] text-foreground/90">{tooltip}</div>
              }
            >
              <span className="cursor-help text-muted-foreground/70 hover:text-foreground">
                <Info className="h-3 w-3" />
              </span>
            </Tooltip>
          )}
        </span>
      </div>
      <div
        className={cn(
          "mt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground",
          centered && "text-center",
        )}
      >
        {mainLabel}
      </div>
      <div
        className={cn(
          "mt-0.5 text-xl font-semibold tabular-nums tracking-tight",
          centered && "text-center",
        )}
      >
        {mainValue}
      </div>
      <div className="mt-1.5 flex items-baseline justify-between gap-2 border-t border-border/40 pt-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {subLabel}
        </span>
        <span className="text-[13px] font-semibold tabular-nums">
          {subValue}
        </span>
      </div>
      {footer && (
        <div className="mt-1 text-[10px] leading-snug text-muted-foreground">
          {footer}
        </div>
      )}
      {children}
    </div>
  );
}

function SectionBlock({
  icon,
  title,
  subtitle,
  accent,
  headline,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  accent: "brand" | "emerald" | "success" | "destructive";
  headline?: {
    label: string;
    value: number;
    pct: number | null;
    tooltip?: string;
    locale: "en" | "ru";
  };
  children: React.ReactNode;
}) {
  const ring =
    accent === "emerald"
      ? "border-emerald-500/30 bg-emerald-500/5"
      : accent === "success"
        ? "border-success/30 bg-success/5"
        : accent === "destructive"
          ? "border-destructive/30 bg-destructive/5"
          : "border-border bg-secondary/30";
  const iconCls =
    accent === "emerald"
      ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-400"
      : accent === "success"
        ? "border-success/40 bg-success/15 text-success"
        : accent === "destructive"
          ? "border-destructive/40 bg-destructive/15 text-destructive"
          : "border-brand-cyan/40 bg-brand-cyan/15 text-brand-cyan";
  const positive = headline ? headline.value >= 0 : true;
  return (
    <div className={cn("rounded-xl border p-3", ring)}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-md border",
              iconCls,
            )}
          >
            {icon}
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-foreground">
              {title}
            </div>
            {subtitle && (
              <div className="text-[10px] text-muted-foreground">{subtitle}</div>
            )}
          </div>
        </div>
        {headline && (
          <div className="flex items-baseline gap-2">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {headline.label}
              {headline.tooltip && (
                <Tooltip
                  maxWidth={300}
                  content={
                    <div className="text-[11px] text-foreground/90">
                      {headline.tooltip}
                    </div>
                  }
                >
                  <span className="ml-1 inline-flex cursor-help align-middle text-muted-foreground/70 hover:text-foreground">
                    <Info className="h-3 w-3" />
                  </span>
                </Tooltip>
              )}
            </span>
            <span
              className={cn(
                "text-xl font-semibold tabular-nums",
                positive ? "text-success" : "text-destructive",
              )}
            >
              {headline.value >= 0 ? "+" : ""}
              {formatUsd(headline.value, headline.locale)}
            </span>
            {headline.pct != null && (
              <span
                className={cn(
                  "text-sm font-medium tabular-nums",
                  positive ? "text-success/90" : "text-destructive/90",
                )}
              >
                ({headline.pct >= 0 ? "+" : ""}
                {headline.pct.toFixed(2)}%)
              </span>
            )}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

function PnlSubMetric({
  label,
  usd,
  pct,
  note,
  tooltip,
  locale,
  empty,
}: {
  label: string;
  usd: number;
  pct: number | null;
  note?: string;
  tooltip?: string;
  locale: "en" | "ru";
  empty?: boolean;
}) {
  const positive = usd >= 0;
  return (
    <div className="rounded-md border border-border/60 bg-card/40 p-2.5">
      <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
        {tooltip && (
          <Tooltip
            maxWidth={280}
            content={
              <div className="text-[11px] text-foreground/90">{tooltip}</div>
            }
          >
            <span className="ml-auto cursor-help text-muted-foreground/70 hover:text-foreground">
              <Info className="h-3 w-3" />
            </span>
          </Tooltip>
        )}
      </div>
      {empty ? (
        <div className="mt-0.5 text-sm font-semibold text-muted-foreground">
          —
        </div>
      ) : (
        <div className="mt-0.5 flex items-baseline gap-1.5">
          <span
            className={cn(
              "text-base font-semibold tabular-nums",
              positive ? "text-success" : "text-destructive",
            )}
          >
            <AnimatedNumber
              value={usd}
              format={(v) => `${v >= 0 ? "+" : ""}${formatUsd(v, locale)}`}
            />
          </span>
          {pct != null && (
            <span
              className={cn(
                "text-[11px] font-medium tabular-nums",
                positive ? "text-success/90" : "text-destructive/90",
              )}
            >
              ({pct >= 0 ? "+" : ""}
              {pct.toFixed(2)}%)
            </span>
          )}
        </div>
      )}
      {note && (
        <div className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
          {note}
        </div>
      )}
    </div>
  );
}

function AprMetric({
  label,
  pct,
  tooltip,
  empty,
}: {
  label: string;
  pct: number | null;
  tooltip?: string;
  empty?: boolean;
}) {
  const positive = pct != null && pct >= 0;
  const color =
    empty || pct == null
      ? "text-muted-foreground"
      : positive
        ? "text-success"
        : "text-destructive";
  return (
    <div className="rounded-lg border border-border/60 bg-card/40 p-3">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
        {tooltip && (
          <Tooltip
            maxWidth={260}
            content={
              <div className="font-mono text-[11px] text-foreground/90">
                {tooltip}
              </div>
            }
          >
            <span className="ml-auto cursor-help text-muted-foreground/70 hover:text-foreground">
              <Info className="h-3 w-3" />
            </span>
          </Tooltip>
        )}
      </div>
      <div className={cn("mt-1 text-lg font-semibold tabular-nums", color)}>
        {empty || pct == null
          ? "—"
          : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`}
      </div>
    </div>
  );
}

function DividendsMetric({
  label,
  value,
  note,
  accent,
  locale,
}: {
  label: string;
  value: number;
  note?: string;
  accent: "emerald" | "success" | "muted";
  locale: "en" | "ru";
}) {
  const valueCls =
    accent === "emerald"
      ? "text-emerald-400"
      : accent === "success"
        ? "text-success"
        : "text-foreground";
  return (
    <div className="rounded-lg border border-border/60 bg-card/40 p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className={cn("mt-1 text-lg font-semibold tabular-nums", valueCls)}>
        <AnimatedNumber value={value} format={(v) => formatUsd(v, locale)} />
      </div>
      {note && <div className="text-[10px] text-muted-foreground">{note}</div>}
    </div>
  );
}

function DetailMetric({
  icon,
  label,
  value,
  sub,
  accent,
  formula,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  sub?: React.ReactNode;
  accent?: "success" | "destructive" | "muted";
  formula?: string;
}) {
  const valueCls =
    accent === "success"
      ? "text-success"
      : accent === "destructive"
        ? "text-destructive"
        : "text-foreground";
  return (
    <div className="rounded-lg border border-border/60 bg-card/40 p-3 transition-colors hover:bg-card/70">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
        {formula && (
          <Tooltip
            maxWidth={260}
            content={
              <div className="font-mono text-[11px] text-foreground/90">
                {formula}
              </div>
            }
          >
            <span className="ml-auto cursor-help text-muted-foreground/70 hover:text-foreground">
              <Info className="h-3 w-3" />
            </span>
          </Tooltip>
        )}
      </div>
      <div className={cn("mt-1 text-base font-semibold tabular-nums", valueCls)}>
        {value}
      </div>
      {sub && (
        <div className="text-[10px] text-muted-foreground tabular-nums">
          {sub}
        </div>
      )}
    </div>
  );
}

/* ============================== Wallets ================================== */

interface AggregatedToken {
  key: string; // symbol|chain — для подзаголовков
  symbol: string;
  /** Адрес контракта/mint первого встреченного токена в этой группе. */
  tokenId?: string;
  chains: string[];
  isStable: boolean;
  amount: number;
  usd: number;
  costBasisUsd: number;
  hasCostBasis: boolean;
  pnlUsd: number | null;
  pnlPct: number | null;
  avgBuyPrice: number | null;
  currentPrice: number | null;
  wallets: { name: string; chain: string; amount: number; usd: number }[];
}

/**
 * Ссылка на explorer для токена по chain.
 * Solana → Jupiter Tokens (богатая metadata).
 * EVM-сети → DeBank (агрегатор).
 * CoinStats-сети → null (нет универсального explorer-ссылки).
 */
function tokenExplorerUrl(chain: string, tokenId: string): string | null {
  if (!tokenId) return null;
  const lower = chain.toLowerCase();
  if (lower === "sol" || lower === "solana") {
    return `https://jup.ag/tokens/${tokenId}`;
  }
  // EVM-цепочки — DeBank поддерживает большинство.
  const evmSupported = new Set([
    "eth", "arb", "op", "base", "matic", "bsc", "avax", "ftm",
    "blast", "scroll", "linea", "mantle", "metis", "zk", "era",
  ]);
  if (evmSupported.has(lower)) {
    return `https://debank.com/profile/${tokenId}`;
  }
  return null;
}

function WalletBalancesBlock({
  loadedList,
  totalUsd,
  cexUsd = 0,
  cexAccounts = [],
  usdRub,
  locale,
  compact = false,
  snapshotCounts,
}: {
  loadedList: Loaded[];
  totalUsd: number;
  /** USD on connected CEX exchanges (Bybit/OKX/Bitget/MEXC/BingX).
   *  Already included in `totalUsd` — passed separately so we can show
   *  a small breakdown "+ CEX $X" under the headline number. */
  cexUsd?: number;
  /** Per-CEX-account valuation. Each entry rendered as its own
   *  accordion section after the on-chain chain groups. */
  cexAccounts?: ReadonlyArray<{
    id: string;
    exchange: string;
    label: string | null;
    totalUsd: number;
    unpricedCount: number;
    assets: ReadonlyArray<{
      asset: string;
      total: number;
      priceUsd: number | null;
      valueUsd: number;
    }>;
  }>;
  usdRub: number;
  locale: "en" | "ru";
  /** Компактный размер (для top-right widget). */
  compact?: boolean;
  /** Server snapshot counts — used when the legacy client compute is
   *  empty (SaaS users without LoadedWalletsProvider cache). */
  snapshotCounts?: {
    readonly walletsCount: number;
    readonly chainsCount: number;
  };
}) {
  // Aggregate by (chain, symbol) — раздельно по сетям, чтобы в UI было
  // видно: «Ethereum: $X», «Arbitrum: $Y», «Solana: $Z», «Sui: $W».
  // Внутри каждой сети — токены агрегируются по символу (SUI на разных
  // SUI-кошельках в одной строке).
  const byChain = useMemo(() => {
    type ChainGroup = {
      chain: string;
      totalUsd: number;
      tokens: AggregatedToken[];
    };

    // Cross-wallet aggregate cost basis по symbol (без chain). Нужно
    // потому что internal transfers между своими кошельками часто идут
    // cross-chain (bridge). После rebuild с internalHashes на отправителе
    // amount=0 (токен ушёл) но costBasisUsd сохраняется в его snapshot. На
    // получателе amount=X, cost=0. Этот aggregate собирает COST со всех
    // wallets в пул per-symbol — для AVG доступна правильная цена.
    type SymAcc = { totalCost: number; totalAmount: number };
    const crossWalletCost = new Map<string, SymAcc>();
    for (const l of loadedList) {
      for (const b of l.snapshot.walletBalances) {
        if (b.costBasisUsd <= 0) continue;
        const sym = b.symbol.toUpperCase();
        const ex = crossWalletCost.get(sym) ?? { totalCost: 0, totalAmount: 0 };
        ex.totalCost += b.costBasisUsd;
        ex.totalAmount += b.amount;
        crossWalletCost.set(sym, ex);
      }
    }
    const crossWalletAvg = (sym: string): number | null => {
      const acc = crossWalletCost.get(sym.toUpperCase());
      if (!acc || acc.totalAmount <= 0) return null;
      return acc.totalCost / acc.totalAmount;
    };

    const chainMap = new Map<string, Map<string, AggregatedToken>>();
    for (const l of loadedList) {
      if (!l.live) continue;
      for (const t of l.live.tokens) {
        if (t.amount <= 0) continue;
        // Раньше фильтр `!t.isKnown` отсекал валидные SUI/TON/Cosmos
        // токены — теперь оставляем всё с балансом, фильтр только по USD.
        // 2026-05-14: порог поднят 0.5 → 1.0 — пользователю мешала пыль
        // (мем-токены копейки и т.п.). Те же $1 применяются и для CEX
        // (CEX_DUST_USD ниже), чтобы оба источника прятали одинаковый шум.
        if (t.usd < 1) continue;
        const chain = t.chain;
        const tokens = chainMap.get(chain) ?? new Map<string, AggregatedToken>();
        const key = t.symbol.toUpperCase();
        const ex = tokens.get(key) ?? {
          key: `${chain}|${key}`,
          symbol: t.symbol,
          tokenId: t.tokenId,
          chains: [chain],
          isStable: t.isStable,
          amount: 0,
          usd: 0,
          costBasisUsd: 0,
          hasCostBasis: false,
          pnlUsd: null,
          pnlPct: null,
          avgBuyPrice: null,
          currentPrice: null,
          wallets: [],
        };
        ex.amount += t.amount;
        ex.usd += t.usd;
        if (t.costBasisUsd != null && t.costBasisUsd > 0) {
          ex.costBasisUsd += t.costBasisUsd;
          ex.hasCostBasis = true;
        } else {
          // Fallback на cross-wallet avg: если cost basis на этом
          // wallet'е = 0 (typично для receiver'а internal transfer),
          // используем aggregate avg по symbol со всех своих кошельков.
          const avg = crossWalletAvg(t.symbol);
          if (avg != null && avg > 0) {
            ex.costBasisUsd += avg * t.amount;
            ex.hasCostBasis = true;
          }
        }
        ex.wallets.push({
          name: l.wallet.name,
          chain: t.chain,
          amount: t.amount,
          usd: t.usd,
        });
        tokens.set(key, ex);
        chainMap.set(chain, tokens);
      }
    }
    const groups: (ChainGroup & {
      variant: "regular" | "receipts" | "lp_vault";
    })[] = [];
    for (const [chain, tokens] of chainMap) {
      let totalUsd = 0;
      let receiptsTotalUsd = 0;
      let lpVaultTotalUsd = 0;
      const list: AggregatedToken[] = [];
      const receiptsList: AggregatedToken[] = [];
      const lpVaultList: AggregatedToken[] = [];
      for (const t of tokens.values()) {
        const isLending = isLendingReceipt(t.symbol);
        const isProto = isProtocolToken(t.symbol);
        // Lending receipts (aXxx, cXxx, variableDebt) → строгие «расписки»
        // LP/Vault позиции (GM/GLV/GLP/FLP/fVLT/UNI-V/SLP/CRV-LP/BPT/LST) → отдельный класс
        // Прочее → regular
        const tokenClass: "regular" | "receipts" | "lp_vault" = isLending
          ? "receipts"
          : isProto
            ? "lp_vault"
            : "regular";
        if (tokenClass === "receipts") {
          receiptsTotalUsd += t.usd;
        } else if (tokenClass === "lp_vault") {
          lpVaultTotalUsd += t.usd;
        } else {
          totalUsd += t.usd;
        }
        // Финализация полей.
        t.currentPrice = t.amount > 0 ? t.usd / t.amount : null;
        if (t.hasCostBasis && t.amount > 0) {
          t.avgBuyPrice = t.costBasisUsd / t.amount;
          t.pnlUsd = t.usd - t.costBasisUsd;
          t.pnlPct =
            t.costBasisUsd > 0
              ? ((t.usd - t.costBasisUsd) / t.costBasisUsd) * 100
              : null;
        }
        t.wallets.sort((a, b) => b.usd - a.usd);
        if (tokenClass === "receipts") receiptsList.push(t);
        else if (tokenClass === "lp_vault") lpVaultList.push(t);
        else list.push(t);
      }
      list.sort((a, b) => b.usd - a.usd);
      receiptsList.sort((a, b) => b.usd - a.usd);
      lpVaultList.sort((a, b) => b.usd - a.usd);
      if (list.length > 0) {
        groups.push({ chain, totalUsd, tokens: list, variant: "regular" });
      }
      if (receiptsList.length > 0) {
        groups.push({
          chain,
          totalUsd: receiptsTotalUsd,
          tokens: receiptsList,
          variant: "receipts",
        });
      }
      if (lpVaultList.length > 0) {
        groups.push({
          chain,
          totalUsd: lpVaultTotalUsd,
          tokens: lpVaultList,
          variant: "lp_vault",
        });
      }
    }
    // Порядок: сначала regular (по USD desc), потом receipts (a/cTokens),
    // потом lp_vault (GM/GLV/fVLT). Внутри каждой группы — по USD desc.
    const variantOrder = { regular: 0, receipts: 1, lp_vault: 2 };
    groups.sort((a, b) => {
      const va = variantOrder[a.variant];
      const vb = variantOrder[b.variant];
      if (va !== vb) return va - vb;
      return b.totalUsd - a.totalUsd;
    });
    return groups;
  }, [loadedList]);

  const totalTokensCount = useMemo(
    () => byChain.reduce((s, g) => s + g.tokens.length, 0),
    [byChain],
  );


  const [collapsed, setCollapsed] = useState(true);
  // Auto-close отключён — пользователь сам управляет состоянием через клик
  // на заголовок (ранее автозакрывался через 5 сек, что мешало просмотру
  // длинного списка балансов).

  // ─── Filters (chains / wallets / source) ──────────────────────────
  //
  // Empty set = "all selected" (no filtering). User toggles chips to
  // narrow. Filters apply ONLY to the token list below — the headline
  // `totalUsd` and counts stay accurate to the full portfolio so the
  // user can always see what 100% looks like.
  const [chainFilter, setChainFilter] = useState<Set<string>>(new Set());
  const [walletFilter, setWalletFilter] = useState<Set<string>>(new Set());
  const [sourceFilter, setSourceFilter] = useState<Set<"onchain" | "cex">>(
    new Set(),
  );
  // CEX section collapse — separate from the global widget collapse so
  // the user can keep on-chain expanded but hide the CEX dust groups.
  const [cexSectionCollapsed, setCexSectionCollapsed] = useState(false);
  // Show CEX dust (priced assets worth < $0.5). Default OFF — most of
  // the time these are abandoned mem-token positions from old trades.
  const [cexShowDust, setCexShowDust] = useState(false);
  // Dust threshold mirrors the on-chain wallet code so both sources
  // hide the same noise. $1 was chosen after user feedback that the
  // CEX dust panel was full of mem-coin remainders worth pennies.
  const CEX_DUST_USD = 1;
  const toggleInSet = <T extends string>(
    setter: React.Dispatch<React.SetStateAction<Set<T>>>,
    v: T,
  ) =>
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });

  // Available on-chain wallet names (from `loadedList`) + CEX-account
  // labels — used to build the wallet-filter chips.
  const availableOnchainWallets = useMemo(
    () =>
      Array.from(new Set(loadedList.map((l) => l.wallet.name))).sort(),
    [loadedList],
  );
  const availableChains = useMemo(
    () => Array.from(new Set(loadedList.flatMap((l) =>
      (l.live?.tokens ?? []).filter((t) => t.amount > 0 && t.usd >= 0.5).map((t) => t.chain),
    ))).sort(),
    [loadedList],
  );

  // Apply filters to chain breakdown. `wallet` filter narrows the
  // tokens-inside-chain via `wallets[].name` membership; the chain
  // itself stays.
  const filteredByChain = useMemo(() => {
    const skipOnchain = sourceFilter.size > 0 && !sourceFilter.has("onchain");
    if (skipOnchain) return [];
    return byChain
      .filter((g) => chainFilter.size === 0 || chainFilter.has(g.chain))
      .map((g) => {
        if (walletFilter.size === 0) return g;
        const filteredTokens = g.tokens
          .map((t) => {
            const ws = t.wallets.filter((w) => walletFilter.has(w.name));
            if (ws.length === 0) return null;
            const amount = ws.reduce((s, w) => s + w.amount, 0);
            const usd = ws.reduce((s, w) => s + w.usd, 0);
            return { ...t, wallets: ws, amount, usd };
          })
          .filter((t): t is NonNullable<typeof t> => t !== null);
        const totalUsd = filteredTokens.reduce((s, t) => s + t.usd, 0);
        return { ...g, tokens: filteredTokens, totalUsd };
      })
      .filter((g) => g.tokens.length > 0);
  }, [byChain, chainFilter, walletFilter, sourceFilter]);

  const filteredCexAccounts = useMemo(() => {
    const skipCex = sourceFilter.size > 0 && !sourceFilter.has("cex");
    if (skipCex) return [];
    // Wallet filter: by exchange-name (case-insensitive).
    const byWallet =
      walletFilter.size === 0
        ? cexAccounts
        : cexAccounts.filter((a) => {
            const candidates = [a.exchange, a.label].filter(
              (s): s is string => !!s,
            );
            return candidates.some((c) => walletFilter.has(c));
          });
    // Apply dust filter to each account's asset list. "Dust" = either:
    //   - priced asset worth < CEX_DUST_USD, or
    //   - unpriced asset (no CoinGecko mapping) — almost always retired
    //     mem-tokens, can't be valued, and user wants them gone by
    //     default. They reappear when «Показать пыль» is toggled.
    if (cexShowDust) return byWallet;
    return byWallet.map((a) => {
      const isDust = (x: { priceUsd: number | null; valueUsd: number }) =>
        x.priceUsd == null || x.valueUsd < CEX_DUST_USD;
      const dustCount = a.assets.filter(isDust).length;
      const visible = a.assets.filter((x) => !isDust(x));
      return { ...a, assets: visible, dustCount };
    });
  }, [cexAccounts, walletFilter, sourceFilter, cexShowDust]);

  const activeFilterCount =
    chainFilter.size + walletFilter.size + sourceFilter.size;
  const clientWalletsCount = useMemo(
    () => new Set(loadedList.map((l) => l.wallet.id)).size,
    [loadedList],
  );
  // Phase F6b: prefer server snapshot counts when the client compute
  // is empty (SaaS users without LoadedWalletsProvider cache).
  const walletsCount =
    clientWalletsCount === 0 && snapshotCounts
      ? snapshotCounts.walletsCount
      : clientWalletsCount;
  const chainsCount =
    byChain.length === 0 && snapshotCounts
      ? snapshotCounts.chainsCount
      : byChain.length;
  const { loadAll, busyId } = useLoadedWallets();
  const navigate = useNavigate();
  const isEmpty = walletsCount === 0;

  return (
    <div className="relative flex flex-col self-start overflow-hidden rounded-2xl border border-border bg-card shadow-lg ring-1 ring-white/5 animate-in fade-in slide-in-from-bottom-2 duration-500 dark:bg-slate-950/60 dark:ring-cyan-400/5">
      <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-brand-gradient opacity-80" />

      {/* Header (без градиента) */}
      <div
        className={cn(
          "relative",
          compact ? "px-3.5 pt-3 pb-3" : "px-5 pt-4 pb-4",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div
              className={cn(
                "flex items-center justify-center rounded-xl bg-gradient-to-br from-brand-mint to-brand-cyan text-slate-900 shadow-md ring-1 ring-white/30",
                compact ? "h-7 w-7 [&_svg]:h-3.5 [&_svg]:w-3.5" : "h-9 w-9",
              )}
            >
              <Wallet className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                Cap Wallet
              </div>
              <div className="truncate text-[11px] font-semibold tracking-tight">
                {walletsCount}{" "}
                {walletsCount === 1 ? "кошелёк" : "кошельков"} ·{" "}
                {chainsCount}{" "}
                {compact ? "сетей" : chainsCount === 1 ? "сеть" : "сетей"} ·{" "}
                {totalTokensCount}{" "}
                {compact ? "т." : "токенов"}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-secondary/50 text-muted-foreground transition-colors hover:border-brand-cyan/50 hover:text-foreground"
            title={collapsed ? "Развернуть" : "Свернуть"}
          >
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 transition-transform duration-300",
                collapsed && "-rotate-90",
              )}
            />
          </button>
        </div>

        {/* Большой баланс */}
        <div className={compact ? "mt-2.5" : "mt-4"}>
          <div className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
            Общий баланс
          </div>
          <div
            className={cn(
              "mt-0.5 font-bold tabular-nums tracking-tight",
              compact ? "text-xl" : "text-3xl",
            )}
          >
            <AnimatedNumber value={totalUsd} format={(v) => formatUsd(v, locale)} />
          </div>
          <div className="text-[10px] tabular-nums text-muted-foreground">
            ≈ {formatRub(totalUsd * usdRub, locale)}
          </div>
          {cexUsd > 0 && (
            <div
              className="mt-0.5 text-[10px] tabular-nums text-brand-cyan/90"
              title="Включает балансы подключённых CEX-бирж (Bybit/OKX/Bitget/MEXC/BingX). Управляется в Реестре."
            >
              · вкл. {formatUsd(cexUsd, locale)} на CEX
            </div>
          )}
          {/* Раньше здесь был warning «⚠ N активов без цены: …» —
              скрыт по запросу пользователя (2026-05-14): сами токены
              уже фильтруются ниже порогом `t.usd < 1`, отдельный
              warning только мозолил глаза. Если когда-нибудь
              понадобится для диагностики синтетики — вернуть из
              истории git. */}
        </div>

        {/* Рабочие кнопки действий */}
        <div className={cn("grid grid-cols-3 gap-1.5", compact ? "mt-2.5" : "mt-4")}>
          <button
            type="button"
            onClick={() => navigate("/registry")}
            className={cn(
              "flex flex-col items-center gap-0.5 rounded-md border border-border bg-secondary/40 font-medium text-foreground/80 transition-all hover:-translate-y-0.5 hover:border-brand-cyan/50 hover:bg-secondary/70 hover:text-foreground",
              compact ? "px-1 py-1.5 text-[10px]" : "px-2 py-2 text-[11px]",
            )}
            title={isEmpty ? "Подключить кошелёк" : "Добавить ещё кошелёк"}
          >
            <Plus className={cn("text-brand-cyan", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
            {isEmpty ? "Подключить" : "Добавить"}
          </button>
          <button
            type="button"
            onClick={() => void loadAll()}
            disabled={Boolean(busyId)}
            className={cn(
              "flex flex-col items-center gap-0.5 rounded-md border border-border bg-secondary/40 font-medium text-foreground/80 transition-all hover:-translate-y-0.5 hover:border-brand-cyan/50 hover:bg-secondary/70 hover:text-foreground disabled:cursor-wait disabled:opacity-60",
              compact ? "px-1 py-1.5 text-[10px]" : "px-2 py-2 text-[11px]",
            )}
            title="Обновить балансы"
          >
            <RefreshIcon
              className={cn(
                "text-brand-cyan",
                compact ? "h-3.5 w-3.5" : "h-4 w-4",
                busyId && "animate-spin",
              )}
            />
            Обновить
          </button>
          <button
            type="button"
            onClick={() => navigate("/registry")}
            className={cn(
              "flex flex-col items-center gap-0.5 rounded-md border border-border bg-secondary/40 font-medium text-foreground/80 transition-all hover:-translate-y-0.5 hover:border-brand-cyan/50 hover:bg-secondary/70 hover:text-foreground",
              compact ? "px-1 py-1.5 text-[10px]" : "px-2 py-2 text-[11px]",
            )}
            title="Открыть Реестр операций"
          >
            <ListIcon className={cn("text-brand-cyan", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
            Реестр
          </button>
        </div>
      </div>

      {/* Token list — collapsible. Сгруппирован по сетям.
          Внутри развёрнутого состояния — скролл с max-h, чтобы длинный
          список балансов не растягивал страницу. */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-300 ease-out",
          collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
        )}
      >
        <div className="overflow-hidden">
          <div className="max-h-[520px] overflow-y-auto overscroll-contain border-t border-border">
            <SourcesIndicator loadedList={loadedList} />

            {/* Filter chips — Сети / Кошельки / Источник */}
            {(availableChains.length > 1 ||
              availableOnchainWallets.length > 1 ||
              cexAccounts.length > 0) && (
              <div className="space-y-1.5 border-b border-border bg-secondary/30 px-3 py-2">
                {/* Source: on-chain vs CEX — shown only if user has both */}
                {cexAccounts.length > 0 && (
                  <FilterChipRow
                    label="Источник"
                    items={[
                      { value: "onchain", label: "On-chain" },
                      { value: "cex", label: "CEX" },
                    ]}
                    selected={sourceFilter as Set<string>}
                    onToggle={(v) =>
                      toggleInSet(
                        setSourceFilter as React.Dispatch<
                          React.SetStateAction<Set<string>>
                        >,
                        v,
                      )
                    }
                  />
                )}
                {/* Chains — only when more than one on-chain net is loaded */}
                {availableChains.length > 1 && (
                  <FilterChipRow
                    label="Сети"
                    items={availableChains.map((c) => ({
                      value: c,
                      label: c.toUpperCase(),
                    }))}
                    selected={chainFilter}
                    onToggle={(v) => toggleInSet(setChainFilter, v)}
                  />
                )}
                {/* Wallets: on-chain names + CEX exchange names */}
                {(availableOnchainWallets.length + cexAccounts.length > 1) && (
                  <FilterChipRow
                    label="Кошельки"
                    items={[
                      ...availableOnchainWallets.map((n) => ({
                        value: n,
                        label: n,
                      })),
                      ...cexAccounts.map((a) => ({
                        value: a.exchange,
                        label: `${a.exchange}${a.label ? ` · ${a.label}` : ""}`,
                      })),
                    ]}
                    selected={walletFilter}
                    onToggle={(v) => toggleInSet(setWalletFilter, v)}
                  />
                )}
                {activeFilterCount > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setChainFilter(new Set());
                      setWalletFilter(new Set());
                      setSourceFilter(new Set());
                    }}
                    className="text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    × сбросить все ({activeFilterCount})
                  </button>
                )}
              </div>
            )}

            {filteredByChain.length === 0 && filteredCexAccounts.length === 0 ? (
              <p className="px-4 py-4 text-sm text-muted-foreground">
                {activeFilterCount > 0
                  ? "Нет балансов под текущие фильтры."
                  : "Нет загруженных балансов."}
              </p>
            ) : (
              filteredByChain.map((group, idx) => (
                <Fragment key={`${group.chain}-${group.variant}`}>
                  {/* Заголовок «Расписки» (a/cTokens, debt) — компактный
                      с tooltip-иконкой вместо длинного описательного блока. */}
                  {group.variant === "receipts" &&
                    filteredByChain[idx - 1]?.variant !== "receipts" && (
                      <div className="flex items-center justify-between gap-2 border-y border-warning/30 bg-warning/5 px-4 py-1.5">
                        <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-warning">
                          <span className="inline-block h-3 w-0.5 rounded bg-warning" />
                          Расписки
                          <Tooltip
                            maxWidth={300}
                            content={
                              <div className="text-[11px] text-foreground/90">
                                <span className="font-semibold">aTokens / cTokens / variableDebt</span> —
                                «бумажки» 1:1 от lending протоколов (Aave,
                                Compound), подтверждающие supply или долг.
                                Уже учтены в «Активы в проектах», поэтому
                                <span className="font-semibold">{" "}не суммируются{" "}</span>
                                в общий капитал, чтобы не было двойного счёта.
                              </div>
                            }
                          >
                            <span className="cursor-help text-warning/70 hover:text-warning">
                              <Info className="h-3 w-3" />
                            </span>
                          </Tooltip>
                        </div>
                        <span className="text-[10px] font-medium normal-case text-warning/80">
                          не входят в капитал
                        </span>
                      </div>
                    )}
                  {/* Заголовок «LP / Vault позиции» (GM/GLV/fVLT/UNI-V/LST) */}
                  {group.variant === "lp_vault" &&
                    filteredByChain[idx - 1]?.variant !== "lp_vault" && (
                      <div className="flex items-center justify-between gap-2 border-y border-brand-cyan/30 bg-brand-cyan/5 px-4 py-1.5">
                        <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-brand-cyan">
                          <span className="inline-block h-3 w-0.5 rounded bg-brand-cyan" />
                          LP / Vault позиции
                          <Tooltip
                            maxWidth={320}
                            content={
                              <div className="text-[11px] text-foreground/90">
                                <span className="font-semibold">GM / GLV / GLP / FLP / fVLT / UNI-V / SLP / stETH / wstETH</span> —
                                это <span className="italic">не расписки</span>,
                                а активные позиции: GMX V2 perp market-making,
                                Fluid Vault NFT, AMM LP-токены, liquid staking
                                derivatives. Стоимость уже учтена через
                                «Активы в проектах», поэтому
                                <span className="font-semibold">{" "}не суммируются{" "}</span>
                                в общий капитал.
                              </div>
                            }
                          >
                            <span className="cursor-help text-brand-cyan/70 hover:text-brand-cyan">
                              <Info className="h-3 w-3" />
                            </span>
                          </Tooltip>
                        </div>
                        <span className="text-[10px] font-medium normal-case text-brand-cyan/80">
                          не входят в капитал
                        </span>
                      </div>
                    )}
                  <ChainGroupSection
                    chain={group.chain}
                    totalUsd={group.totalUsd}
                    tokens={group.tokens}
                    walletTotalUsd={totalUsd}
                    locale={locale}
                    compact={compact}
                    variant={group.variant}
                  />
                </Fragment>
              ))
            )}
            {/* CEX accounts — rendered after on-chain chain groups so
                the visual separation between "on-chain" and "exchange"
                is obvious. Section header is clickable to collapse the
                whole CEX block (chain groups stay visible). */}
            {filteredCexAccounts.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => setCexSectionCollapsed((v) => !v)}
                  className="flex w-full items-center justify-between gap-2 border-y border-brand-cyan/30 bg-brand-cyan/5 px-4 py-1.5 transition-colors hover:bg-brand-cyan/10"
                >
                  <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-brand-cyan">
                    <ChevronDown
                      className={cn(
                        "h-3 w-3 transition-transform",
                        cexSectionCollapsed && "-rotate-90",
                      )}
                    />
                    <span className="inline-block h-3 w-0.5 rounded bg-brand-cyan" />
                    Биржи (CEX)
                  </span>
                  <span className="flex items-center gap-2 text-[10px]">
                    {!cexSectionCollapsed && (() => {
                      const totalDust = filteredCexAccounts.reduce(
                        (s, a) =>
                          s + ((a as { dustCount?: number }).dustCount ?? 0),
                        0,
                      );
                      return totalDust > 0 ? (
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation();
                            setCexShowDust((v) => !v);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              e.stopPropagation();
                              setCexShowDust((v) => !v);
                            }
                          }}
                          className="cursor-pointer rounded border border-brand-cyan/40 bg-brand-cyan/10 px-1.5 py-px font-medium normal-case text-brand-cyan/90 hover:bg-brand-cyan/20"
                        >
                          {cexShowDust
                            ? "скрыть пыль"
                            : `+${totalDust} пыль`}
                        </span>
                      ) : null;
                    })()}
                    <span className="tabular-nums text-brand-cyan/80">
                      {formatUsd(
                        filteredCexAccounts.reduce((s, a) => s + a.totalUsd, 0),
                        locale,
                      )}
                    </span>
                  </span>
                </button>
                {!cexSectionCollapsed &&
                  filteredCexAccounts.map((acc) => (
                    <CexAccountGroup
                      key={acc.id}
                      account={acc}
                      walletTotalUsd={totalUsd}
                      locale={locale}
                      compact={compact}
                    />
                  ))}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Render one CEX account's assets as a chain-style group inside the
 * Cap Wallet widget. Visually consistent with the on-chain chain
 * groups above so the user perceives "Bitget" and "ETH" as parallel
 * "sources" of capital.
 */
function CexAccountGroup({
  account,
  walletTotalUsd,
  locale,
  compact,
}: {
  account: {
    id: string;
    exchange: string;
    label: string | null;
    totalUsd: number;
    unpricedCount: number;
    assets: ReadonlyArray<{
      asset: string;
      total: number;
      priceUsd: number | null;
      valueUsd: number;
    }>;
  };
  walletTotalUsd: number;
  locale: "en" | "ru";
  compact: boolean;
}) {
  const headerName = account.label
    ? `${account.exchange} · ${account.label}`
    : account.exchange;
  const pct =
    walletTotalUsd > 0 ? (account.totalUsd / walletTotalUsd) * 100 : 0;
  return (
    <div className="border-b border-border/60 last:border-b-0">
      <div
        className={cn(
          "flex items-center justify-between gap-2 bg-secondary/30",
          compact ? "px-3 py-1" : "px-4 py-1.5",
        )}
      >
        <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-foreground/80">
          {headerName}
          {account.unpricedCount > 0 && (
            <span
              className="rounded border border-warning/40 bg-warning/10 px-1 py-px text-[9px] normal-case text-warning"
              title={`${account.unpricedCount} актив(ов) без CoinGecko-цены — не учтены в сумме.`}
            >
              {account.unpricedCount} без цены
            </span>
          )}
        </span>
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {formatUsd(account.totalUsd, locale)}
          {pct > 0 && <span className="ml-1 opacity-70">· {pct.toFixed(1)}%</span>}
        </span>
      </div>
      {account.assets.length === 0 ? (
        <p className={cn("text-[11px] text-muted-foreground", compact ? "px-3 py-1" : "px-4 py-1.5")}>
          Нет активов в последнем snapshot. Нажмите «Синхронизировать» на бирже в Реестре.
        </p>
      ) : (
        <ul>
          {account.assets.map((a) => (
            <li
              key={a.asset}
              className={cn(
                "flex items-center justify-between gap-2 text-[11px]",
                compact ? "px-3 py-1" : "px-4 py-1.5",
              )}
            >
              <span className="font-mono uppercase text-foreground">
                {a.asset}
              </span>
              <span className="flex items-center gap-2 tabular-nums">
                <span className="text-muted-foreground">
                  {formatNumber(a.total, locale, 6)}
                </span>
                {a.priceUsd != null ? (
                  <span className="text-foreground/80">
                    {formatUsd(a.valueUsd, locale)}
                  </span>
                ) : (
                  <span
                    className="text-warning/80"
                    title="Нет CoinGecko-цены — не учтён в сумме капитала."
                  >
                    —
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Multi-select filter chip row used inside the Cap Wallet widget.
 * Empty selection = "all" (no filter). Matches the visual language of
 * the chips used in RegistryPage for consistency.
 */
function FilterChipRow({
  label,
  items,
  selected,
  onToggle,
}: {
  label: string;
  items: ReadonlyArray<{ value: string; label: string }>;
  selected: Set<string>;
  onToggle: (v: string) => void;
}) {
  return (
    <div className="space-y-0.5">
      <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
        {selected.size > 0 && (
          <span className="ml-1 rounded-full bg-brand-cyan/15 px-1 text-[9px] font-bold text-brand-cyan">
            {selected.size}
          </span>
        )}
      </span>
      <div className="flex flex-wrap gap-1">
        {items.map((it) => {
          const active = selected.has(it.value);
          return (
            <button
              key={it.value}
              type="button"
              onClick={() => onToggle(it.value)}
              className={cn(
                "inline-flex items-center rounded-full border px-1.5 py-px text-[10px] transition-all",
                active
                  ? "border-brand-cyan/60 bg-brand-cyan/15 text-brand-cyan"
                  : "border-border bg-secondary/50 text-muted-foreground hover:border-brand-cyan/30 hover:text-foreground",
              )}
            >
              {it.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Раскрываемый индикатор источников данных по всем кошелькам.
 * Показывает какие провайдеры (DeBank / Helius / Vybe / Jupiter / Shyft /
 * CoinStats / DEX Screener) сработали при последней загрузке. Помогает
 * быстро понять «работает ли Shyft», «дёргает ли вообще CoinStats» и т.д.
 */
function SourcesIndicator({
  loadedList,
}: {
  loadedList: Loaded[];
}) {
  const [expanded, setExpanded] = useState(false);

  // Собираем сводку по источникам: имя → { wallets, tokens, positions, fails }.
  const summary = useMemo(() => {
    const map = new Map<
      string,
      { wallets: number; tokens: number; positions: number; fails: number }
    >();
    for (const l of loadedList) {
      for (const s of l.live?.sources ?? []) {
        const ex = map.get(s.name) ?? {
          wallets: 0,
          tokens: 0,
          positions: 0,
          fails: 0,
        };
        ex.wallets += 1;
        ex.tokens += s.tokens ?? 0;
        ex.positions += s.positions ?? 0;
        if (!s.ok) ex.fails += 1;
        map.set(s.name, ex);
      }
    }
    return [...map.entries()].sort((a, b) => b[1].wallets - a[1].wallets);
  }, [loadedList]);

  if (summary.length === 0) return null;

  return (
    <div className="border-b border-border/60 bg-secondary/20">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-4 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:bg-secondary/40"
      >
        <span className="flex items-center gap-1.5">
          <ChevronDown
            className={cn(
              "h-3 w-3 transition-transform",
              !expanded && "-rotate-90",
            )}
          />
          Источники данных
          <span className="text-muted-foreground/60">·</span>
          <span className="text-foreground/80">{summary.length}</span>
        </span>
        <span className="flex flex-wrap items-center gap-1">
          {summary.slice(0, 4).map(([name, info]) => (
            <span
              key={name}
              className={cn(
                "rounded border px-1 py-0.5 text-[9px] font-mono uppercase tracking-wide",
                info.fails > 0
                  ? "border-warning/40 bg-warning/10 text-warning"
                  : "border-success/30 bg-success/10 text-success",
              )}
              title={
                info.fails > 0
                  ? `${name}: упал на ${info.fails}/${info.wallets} кошельках`
                  : `${name}: работает на ${info.wallets} кошельках`
              }
            >
              {name}
            </span>
          ))}
          {summary.length > 4 && (
            <span className="text-[9px] text-muted-foreground/70">
              +{summary.length - 4}
            </span>
          )}
        </span>
      </button>
      {expanded && (
        <div className="space-y-1 px-4 py-2 text-[10px]">
          {loadedList.map((l) => (
            <div key={l.wallet.name} className="flex flex-col gap-0.5">
              <div className="font-semibold text-foreground/90">
                {l.wallet.name}
              </div>
              <div className="flex flex-wrap gap-1 pl-2">
                {(l.live?.sources ?? []).map((s, i) => (
                  <span
                    key={i}
                    className={cn(
                      "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono",
                      s.ok
                        ? "border-success/40 bg-success/10 text-success"
                        : "border-destructive/40 bg-destructive/10 text-destructive",
                    )}
                    title={s.error ?? ""}
                  >
                    {s.ok ? "✓" : "✗"} {s.name}
                    {s.tokens != null && ` ${s.tokens}t`}
                    {s.positions != null && ` ${s.positions}p`}
                  </span>
                ))}
                {(l.live?.sources ?? []).length === 0 && (
                  <span className="text-muted-foreground/60">нет данных</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const CHAIN_DISPLAY: Record<string, string> = {
  eth: "Ethereum",
  arb: "Arbitrum",
  op: "Optimism",
  base: "Base",
  matic: "Polygon",
  bsc: "BNB Chain",
  avax: "Avalanche",
  ftm: "Fantom",
  blast: "Blast",
  scroll: "Scroll",
  zk: "zkSync",
  linea: "Linea",
  mantle: "Mantle",
  metis: "Metis",
  era: "zkSync Era",
  sol: "Solana",
  bitcoin: "Bitcoin",
  litecoin: "Litecoin",
  doge: "Dogecoin",
  "ton-wallet": "TON",
  "sui-wallet": "Sui",
  "aptos-wallet": "Aptos",
  "near-wallet": "NEAR",
  cardano: "Cardano",
  tron: "Tron",
  cosmos: "Cosmos",
};

function chainLabel(chain: string): string {
  if (CHAIN_DISPLAY[chain]) return CHAIN_DISPLAY[chain]!;
  // ENV-style суффиксы — capitalise.
  return chain.toUpperCase().replace(/-WALLET$/, "");
}

function ChainGroupSection({
  chain,
  totalUsd,
  tokens,
  walletTotalUsd,
  locale,
  compact,
  variant = "regular",
}: {
  chain: string;
  totalUsd: number;
  tokens: AggregatedToken[];
  walletTotalUsd: number;
  locale: "en" | "ru";
  compact: boolean;
  /**
   * `regular` — обычные активы (брендовый cyan accent).
   * `receipts` — строгие расписки (aTokens, cTokens, debt) — warning accent.
   * `lp_vault` — LP/Vault позиции (GM/GLV/fVLT/UNI-V/LST) — muted accent
   *   (не warning, потому что это активные позиции, а не «неактивные расписки»).
   */
  variant?: "regular" | "receipts" | "lp_vault";
}) {
  // По умолчанию все секции свёрнуты — пользователь сам раскрывает нужную сеть.
  const [expanded, setExpanded] = useState(false);
  const sharePct =
    walletTotalUsd > 0 ? (totalUsd / walletTotalUsd) * 100 : 0;
  const isReceipts = variant === "receipts";
  const isLpVault = variant === "lp_vault";
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "relative flex w-full items-center justify-between gap-2 border-y border-l-2 px-4 py-1.5 text-[10px] font-medium uppercase tracking-wider transition-colors",
          isReceipts
            ? "border-y-warning/20 border-l-warning/70 bg-warning/[0.03] text-warning/90 hover:bg-warning/10"
            : isLpVault
              ? "border-y-brand-cyan/20 border-l-brand-cyan/60 bg-brand-cyan/[0.03] text-brand-cyan/90 hover:bg-brand-cyan/10"
              : "border-y-brand-cyan/30 border-l-brand-cyan bg-brand-cyan/5 text-brand-cyan hover:bg-brand-cyan/10",
        )}
      >
        <span className="flex items-center gap-1.5">
          <ChevronDown
            className={cn(
              "h-3 w-3 transition-transform",
              !expanded && "-rotate-90",
            )}
          />
          {chainLabel(chain)}
          <span className="opacity-50">·</span>
          <span className="font-bold">{tokens.length}</span>
          {isReceipts && (
            <Badge
              variant="outline"
              className="ml-1 h-3.5 border-warning/40 px-1 text-[8px] text-warning"
            >
              расписка
            </Badge>
          )}
          {isLpVault && (
            <Badge
              variant="outline"
              className="ml-1 h-3.5 border-brand-cyan/40 px-1 text-[8px] text-brand-cyan/90"
            >
              LP / vault
            </Badge>
          )}
        </span>
        <span className="flex items-center gap-2 tabular-nums">
          <span className="font-bold">{formatUsd(totalUsd, locale)}</span>
          <span className="opacity-70">{sharePct.toFixed(1)}%</span>
        </span>
      </button>
      {expanded && (
        <div className="divide-y divide-border/60">
          {tokens.map((t, i) => {
            const share =
              walletTotalUsd > 0 ? (t.usd / walletTotalUsd) * 100 : 0;
            return (
              <TokenListRow
                key={t.key}
                token={t}
                share={share}
                delay={i * 20}
                locale={locale}
                compact={compact}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Маленькая иконка-ссылка на explorer токена. Hover показывает full mint
 * адрес для копирования. Если для chain нет explorer-роутера — рендерится
 * только tooltip с адресом (без ссылки).
 */
function TokenExplorerLink({
  chain,
  tokenId,
  size = "sm",
}: {
  chain: string;
  tokenId: string | undefined;
  size?: "xs" | "sm";
}) {
  if (!tokenId) return null;
  const url = tokenExplorerUrl(chain, tokenId);
  const iconSize = size === "xs" ? "h-2.5 w-2.5" : "h-3 w-3";
  const buttonSize = size === "xs" ? "h-3.5 w-3.5" : "h-4 w-4";
  const className = cn(
    "inline-flex shrink-0 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:text-brand-cyan",
    buttonSize,
  );
  if (!url) {
    return (
      <span className={className} title={tokenId}>
        <ExternalLink className={iconSize} />
      </span>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={className}
      title={`${tokenId}\n\nОткрыть в explorer →`}
    >
      <ExternalLink className={iconSize} />
    </a>
  );
}

function TokenListRow({
  token,
  share,
  delay,
  locale,
  compact = false,
}: {
  token: AggregatedToken;
  share: number;
  delay: number;
  locale: "en" | "ru";
  compact?: boolean;
}) {
  const positive = (token.pnlUsd ?? 0) >= 0;
  if (compact) {
    // Узкий вариант для top-right Cap Wallet (300px ширина):
    // 2-строчное представление с полным PnL: символ + amount + share слева,
    // ниже avg/current; справа — USD + PnL$ + PnL%.
    return (
      <div
        className="flex items-center gap-2 px-3 py-2 transition-colors hover:bg-accent/40 animate-in fade-in slide-in-from-bottom-1"
        style={{ animationDelay: `${Math.min(delay, 400)}ms` }}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <span className="truncate text-[12px] font-semibold">
              {token.symbol}
            </span>
            {token.isStable && (
              <Badge variant="muted" className="h-3.5 px-1 text-[8px]">
                stable
              </Badge>
            )}
            <TokenExplorerLink
              chain={token.chains[0] ?? ""}
              tokenId={token.tokenId}
              size="xs"
            />
          </div>
          <div className="text-[9px] tabular-nums text-muted-foreground">
            {formatNumber(token.amount, locale, 4)} · {share.toFixed(1)}%
          </div>
          {token.avgBuyPrice != null && token.currentPrice != null && (
            <div className="text-[9px] tabular-nums text-muted-foreground/80">
              ср. {formatUsd(token.avgBuyPrice, locale)}
              <span className="opacity-60"> → </span>
              {formatUsd(token.currentPrice, locale)}
            </div>
          )}
        </div>
        <div className="shrink-0 text-right tabular-nums">
          <div className="text-[12px] font-bold">
            {formatUsd(token.usd, locale)}
          </div>
          {token.pnlUsd != null && token.pnlPct != null ? (
            <>
              <div
                className={cn(
                  "text-[10px] font-semibold",
                  positive ? "text-success" : "text-destructive",
                )}
              >
                {positive ? "+" : ""}
                {formatUsd(token.pnlUsd, locale)}
              </div>
              <div
                className={cn(
                  "text-[9px] font-medium",
                  positive ? "text-success/80" : "text-destructive/80",
                )}
              >
                {positive ? "+" : ""}
                {token.pnlPct.toFixed(2)}%
              </div>
            </>
          ) : (
            <div className="text-[9px] italic text-muted-foreground">
              cost basis ?
            </div>
          )}
        </div>
      </div>
    );
  }
  return (
    <div
      className="group flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-accent/40 animate-in fade-in slide-in-from-bottom-1"
      style={{ animationDelay: `${Math.min(delay, 400)}ms` }}
    >
      {/* Symbol + chains + wallets (без аватарки — оставили только символ) */}
      <div className="min-w-0 flex-[1.4]">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-semibold">{token.symbol}</span>
          {token.isStable && (
            <Badge variant="muted" className="h-4 px-1 text-[9px]">
              stable
            </Badge>
          )}
          <TokenExplorerLink
            chain={token.chains[0] ?? ""}
            tokenId={token.tokenId}
            size="sm"
          />
          {token.chains.map((c) => (
            <Badge
              key={c}
              variant="outline"
              className="h-4 px-1 text-[9px] uppercase"
            >
              {c}
            </Badge>
          ))}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
          {token.wallets.map((w, i) => (
            <span key={i} className="inline-flex items-center gap-1">
              <span className="truncate font-medium text-foreground/80">
                {w.name}
              </span>
              <span className="opacity-70">
                ({formatNumber(w.amount, locale, 4)})
              </span>
              {i < token.wallets.length - 1 && (
                <span className="text-muted-foreground/40">·</span>
              )}
            </span>
          ))}
        </div>
      </div>

      {/* Amount + avg buy price */}
      <div className="hidden flex-1 text-right text-[11px] tabular-nums sm:block">
        <div className="text-foreground/90">
          {formatNumber(token.amount, locale, 6)} {token.symbol}
        </div>
        <div className="text-muted-foreground">
          {token.avgBuyPrice != null
            ? `ср. ${formatUsd(token.avgBuyPrice, locale)}`
            : "—"}
          {token.currentPrice != null && token.avgBuyPrice != null && (
            <span className="ml-1 opacity-70">
              · сейчас {formatUsd(token.currentPrice, locale)}
            </span>
          )}
        </div>
      </div>

      {/* PNL */}
      <div className="hidden flex-1 text-right tabular-nums md:block">
        {token.pnlUsd != null && token.pnlPct != null ? (
          <>
            <div
              className={cn(
                "text-sm font-semibold",
                positive ? "text-success" : "text-destructive",
              )}
            >
              {positive ? "+" : ""}
              {formatUsd(token.pnlUsd, locale)}
            </div>
            <div
              className={cn(
                "text-[10px]",
                positive ? "text-success/80" : "text-destructive/80",
              )}
            >
              {positive ? "+" : ""}
              {token.pnlPct.toFixed(2)}%
            </div>
          </>
        ) : (
          <span className="text-[11px] text-muted-foreground">
            cost basis ?
          </span>
        )}
      </div>

      {/* USD + share */}
      <div className="w-28 shrink-0 text-right tabular-nums">
        <div className="text-base font-semibold">
          {formatUsd(token.usd, locale)}
        </div>
        <div className="mt-1 flex items-center gap-1.5">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-secondary/60">
            <div
              className="h-full rounded-full bg-brand-gradient transition-all duration-500"
              style={{ width: `${Math.min(100, share)}%` }}
            />
          </div>
          <span className="text-[10px] font-medium text-muted-foreground">
            {share.toFixed(1)}%
          </span>
        </div>
      </div>
    </div>
  );
}

/* ============================== Protocols ================================ */

/**
 * F6b slice 3 server-driven "Активы в проектах" card. Read-only —
 * renders when the legacy client compute (`metrics.protocols`) is empty
 * but the worker has populated `snapshot.protocols`. Each row shows
 * protocol + chain + asset/debt + wallets that hold the position +
 * top supply tokens. No per-position expand yet — full PnL/APR/lots
 * lives in a later slice once those land server-side.
 */
function SnapshotProtocolsBlock({
  protocols,
  protocolsAssetUsd,
  protocolsDebtUsd,
  locale,
}: {
  protocols: NonNullable<SnapshotMetrics["protocols"]>;
  protocolsAssetUsd: number;
  protocolsDebtUsd: number;
  locale: "en" | "ru";
}) {
  const net = protocolsAssetUsd - protocolsDebtUsd;
  return (
    <Card className="self-start animate-in fade-in slide-in-from-bottom-2 duration-500">
      <span className="pointer-events-none absolute inset-x-6 -top-px h-px bg-brand-gradient" />
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-secondary text-brand-cyan">
            <Layers className="h-4 w-4" />
          </div>
          <div>
            <CardTitle className="text-base">Активы в проектах</CardTitle>
            <CardDescription>
              {protocols.length} протоколов · server snapshot
            </CardDescription>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Активы в работе
          </div>
          <div className="text-xl font-semibold tabular-nums text-foreground">
            <AnimatedNumber
              value={protocolsAssetUsd}
              format={(v) => formatUsd(v, locale)}
            />
          </div>
          {protocolsDebtUsd > 0 && (
            <div className="text-[11px] tabular-nums text-muted-foreground">
              −{" "}
              <span className="text-destructive">
                {formatUsd(protocolsDebtUsd, locale)}
              </span>{" "}
              долг = {formatUsd(net, locale)} нетто
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-1.5">
          {protocols.map((p) => (
            <div
              key={`${p.id}|${p.chain}`}
              className="flex items-center justify-between gap-3 rounded-md border border-border bg-secondary/30 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-foreground">{p.name}</span>
                  <Badge variant="muted" className="text-[9px]">
                    {p.chain}
                  </Badge>
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {p.walletNames.join(", ") || "—"} ·{" "}
                  {p.supplyTokens
                    .slice(0, 3)
                    .map((t) => `${t.amount.toFixed(t.amount < 1 ? 4 : 2)} ${t.symbol}`)
                    .join(" + ")}
                  {p.supplyTokens.length > 3 && ` + ${p.supplyTokens.length - 3} more`}
                </div>
              </div>
              <div className="text-right tabular-nums">
                <div className="font-semibold text-foreground">
                  {formatUsd(p.assetUsd, locale)}
                </div>
                {p.debtUsd > 0 && (
                  <div className="text-[10px] text-destructive">
                    − {formatUsd(p.debtUsd, locale)}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ProtocolsBlock({
  metrics,
  opsByWalletId,
  locale,
  compositions,
  onConfigureComposition,
  aaveReserveConfigs,
}: {
  metrics: DashboardMetrics;
  opsByWalletId: Map<string, ClassifiedOp[]>;
  locale: "en" | "ru";
  compositions: import("@/lib/portfolio/asset_composition").AssetCompositions;
  onConfigureComposition: (symbol: string, scope?: string, label?: string) => void;
  aaveReserveConfigs: AaveReserveConfigMap;
}) {
  // Доли — от общей суммы активов в работе (Σ assetUsd), чтобы внутри
  // блока проценты складывались в 100%.
  const protocolsTotalAsset = metrics.protocolsAssetUsd;
  const protocolsTotalDebt = metrics.protocolsDebtUsd;
  const protocolsTotalNet = metrics.protocolsNetUsd;
  // Total PnL берём из точной формулы, что в «Лист открытых позиций»
  // (totalAssets − invested), чтобы цифры в дашборде и на странице совпадали.
  const totalPnlUsd = metrics.protocolsTotalPnlUsd;
  const totalPnlPct = metrics.protocolsTotalPnlPct;

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const allExpanded =
    metrics.protocols.length > 0 && expanded.size === metrics.protocols.length;
  const toggleAll = () => {
    if (allExpanded) setExpanded(new Set());
    else setExpanded(new Set(metrics.protocols.map((p) => p.protocolId)));
  };
  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <Card className="self-start animate-in fade-in slide-in-from-bottom-2 duration-500">
      <span className="pointer-events-none absolute inset-x-6 -top-px h-px bg-brand-gradient" />
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-secondary text-brand-cyan">
            <Layers className="h-4 w-4" />
          </div>
          <div>
            <CardTitle className="text-base">Активы в проектах</CardTitle>
            <CardDescription>
              {metrics.protocols.length} протоколов · нажмите карточку для
              деталей
            </CardDescription>
          </div>
          {metrics.protocols.length > 0 && (
            <button
              type="button"
              onClick={toggleAll}
              className="ml-2 inline-flex items-center gap-1 self-center rounded-md border border-border bg-secondary/40 px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:border-brand-cyan/40 hover:text-foreground"
              title={allExpanded ? "Свернуть все" : "Развернуть все"}
            >
              <ChevronDown
                className={cn(
                  "h-3 w-3 transition-transform",
                  !allExpanded && "-rotate-90",
                )}
              />
              {allExpanded ? "Свернуть всё" : "Развернуть всё"}
            </button>
          )}
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Активы в работе
          </div>
          <div className="text-xl font-semibold tabular-nums text-foreground">
            <AnimatedNumber
              value={protocolsTotalAsset}
              format={(v) => formatUsd(v, locale)}
            />
          </div>
          {protocolsTotalDebt > 0 && (
            <div className="text-[11px] tabular-nums text-muted-foreground">
              −{" "}
              <span className="text-destructive">
                {formatUsd(protocolsTotalDebt, locale)}
              </span>{" "}
              долг = {formatUsd(protocolsTotalNet, locale)} нетто
            </div>
          )}
          {totalPnlPct != null && (
            <div
              className={cn(
                "mt-0.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
                totalPnlUsd >= 0
                  ? "bg-success/15 text-success"
                  : "bg-destructive/15 text-destructive",
              )}
            >
              {totalPnlUsd >= 0 ? (
                <ArrowUpRight className="h-3 w-3" />
              ) : (
                <ArrowDownRight className="h-3 w-3" />
              )}
              Total PnL {totalPnlUsd >= 0 ? "+" : ""}
              {formatUsd(totalPnlUsd, locale)} ({totalPnlUsd >= 0 ? "+" : ""}
              {totalPnlPct.toFixed(2)}%)
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {metrics.protocols.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Загрузи кошельки в{" "}
            <a className="text-brand-cyan hover:underline" href="/registry">
              Реестре операций
            </a>
            .
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {metrics.protocols.map((p, i) => (
              <ProtocolRow
                key={p.protocolId}
                p={p}
                opsByWalletId={opsByWalletId}
                locale={locale}
                delay={i * 40}
                expanded={expanded.has(p.protocolId)}
                onToggle={() => toggle(p.protocolId)}
                compositions={compositions}
                onConfigureComposition={onConfigureComposition}
                aaveReserveConfigs={aaveReserveConfigs}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ProtocolRow({
  p,
  opsByWalletId,
  locale,
  delay,
  expanded,
  onToggle,
  compositions,
  onConfigureComposition,
  aaveReserveConfigs,
}: {
  p: ProtocolBreakdown;
  opsByWalletId: Map<string, ClassifiedOp[]>;
  locale: "en" | "ru";
  delay: number;
  expanded: boolean;
  onToggle: () => void;
  compositions: import("@/lib/portfolio/asset_composition").AssetCompositions;
  onConfigureComposition: (symbol: string, scope?: string, label?: string) => void;
  aaveReserveConfigs: AaveReserveConfigMap;
}) {
  const positive = p.totalPnlUsd >= 0;
  const sharePct = p.shareOfWork * 100;
  // Min HF среди lending-позиций.
  const minHf = (() => {
    const hfs = p.positions
      .filter((pos) => pos.kind === "lending" && pos.healthRate != null)
      .map((pos) => pos.healthRate as number);
    return hfs.length > 0 ? Math.min(...hfs) : null;
  })();
  const hfTone =
    minHf == null
      ? null
      : minHf < 1.3
        ? "text-destructive"
        : minHf < 1.6
          ? "text-warning"
          : "text-success";
  // Иконка по типу: lending, lp, staking — даёт визуальную привязку.
  const kindIcon =
    p.positions[0]?.kind === "lending" ? (
      <Landmark className="h-4 w-4" />
    ) : (
      <Layers className="h-4 w-4" />
    );

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-xl border bg-card transition-all duration-300 animate-in fade-in slide-in-from-bottom-2",
        expanded
          ? "border-brand-cyan/50 shadow-md ring-1 ring-brand-cyan/10"
          : "border-border hover:border-brand-cyan/30 hover:shadow-sm",
      )}
      style={{ animationDelay: `${Math.min(delay, 400)}ms` }}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
      >
        {/* Chevron + Иконка */}
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200",
            !expanded && "-rotate-90",
          )}
        />
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-brand-cyan/30 bg-brand-cyan/10 text-brand-cyan [&_svg]:h-4 [&_svg]:w-4">
          {kindIcon}
        </div>

        {/* Левая колонка: имя/мета/токены/риски (3 строки максимум) */}
        <div className="min-w-0 flex-1 space-y-1">
          {/* Строка 1: название + chain badge + share% */}
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-bold tracking-tight">
              {p.protocolName}
            </span>
            <Badge
              variant="outline"
              className="h-4 shrink-0 px-1 text-[9px] font-semibold uppercase"
            >
              {p.chain}
            </Badge>
            <span className="ml-auto shrink-0 text-[11px] font-bold tabular-nums text-brand-cyan">
              {sharePct.toFixed(1)}%
            </span>
          </div>

          {/* Строка 2: тип · кол-во позиций · кошелёк (muted, info) */}
          <div className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
            <span className="font-semibold uppercase tracking-wider">
              {p.positions[0]?.kind ?? "—"}
            </span>
            <span className="opacity-50">·</span>
            <span>
              {p.positions.length}{" "}
              {p.positions.length === 1 ? "позиция" : "позиций"}
            </span>
            <span className="opacity-50">·</span>
            <span className="truncate">{p.walletNames.join(", ")}</span>
          </div>

          {/* Строка 3: токены + риск-pills inline */}
          <div className="flex flex-wrap items-center gap-1.5">
            {(() => {
              const pairs = new Set<string>();
              for (const pos of p.positions) {
                const supply = pos.supplyTokens
                  .map((t) => t.symbol)
                  .filter(Boolean)
                  .join(" + ");
                const debt = pos.debtTokens
                  .map((t) => t.symbol)
                  .filter(Boolean)
                  .join(" + ");
                if (!supply && !debt) continue;
                const repr =
                  pos.kind === "lending" && debt
                    ? `${supply} ↔ ${debt}`
                    : supply || debt;
                pairs.add(repr);
              }
              return Array.from(pairs).map((repr) => (
                <Badge
                  key={repr}
                  variant="outline"
                  className="h-5 px-1.5 text-[10px] font-semibold tabular-nums"
                >
                  {repr}
                </Badge>
              ));
            })()}
            {minHf != null && hfTone && (
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-bold tabular-nums",
                  minHf < 1.3
                    ? "border-destructive/40 bg-destructive/10"
                    : minHf < 1.6
                      ? "border-warning/40 bg-warning/10"
                      : "border-success/40 bg-success/10",
                  hfTone,
                )}
              >
                HF {minHf.toFixed(2)}
              </span>
            )}
            {p.debtUsd > 0 && (
              <span className="inline-flex items-center rounded-full border border-destructive/30 bg-destructive/5 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-destructive">
                {formatUsd(p.debtUsd, locale)} долг
              </span>
            )}
          </div>
        </div>

        {/* Правая колонка: стоимость + PnL pill + дивиденды.
            Чёткая иерархия: 18px primary value → 11px PnL pill → 11px sub. */}
        <div className="flex shrink-0 flex-col items-end gap-1 text-right">
          <div className="text-lg font-bold tabular-nums leading-tight">
            {formatUsd(p.assetUsd, locale)}
          </div>
          {p.startUsd > 0 ? (
            <div
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums",
                positive
                  ? "bg-success/15 text-success"
                  : "bg-destructive/15 text-destructive",
              )}
            >
              {positive ? (
                <ArrowUpRight className="h-3 w-3" />
              ) : (
                <ArrowDownRight className="h-3 w-3" />
              )}
              {positive ? "+" : ""}
              {formatUsd(p.totalPnlUsd, locale)}
              {p.totalPnlPct != null && (
                <span className="opacity-80">
                  {" "}
                  ({positive ? "+" : ""}
                  {p.totalPnlPct.toFixed(2)}%)
                </span>
              )}
            </div>
          ) : (
            <div className="text-[10px] italic text-muted-foreground">
              cost basis ?
            </div>
          )}
          {p.feesClaimedUsd > 0 && (
            <div className="text-[10px] font-medium tabular-nums text-success/80">
              + {formatUsd(p.feesClaimedUsd, locale)} див.
            </div>
          )}
        </div>
      </button>

      {/* Тонкая нижняя полоска доли — визуальный индикатор без лейблов */}
      <div className="h-1 w-full bg-secondary/50">
        <div
          className="h-full bg-brand-gradient transition-all duration-700"
          style={{ width: `${Math.min(100, sharePct)}%` }}
        />
      </div>

      {/* Expanded content */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-300 ease-out",
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">
          <div className="space-y-2 border-t border-border/60 bg-card/50 px-3 py-2">
            {(() => {
              // Aggregate borrow info по всему протоколу (один раз) для
              // правильного pro-rata разделения накопленных % между позициями.
              const lendingPositions = p.positions.filter(
                (pos) => pos.kind === "lending",
              );
              // Все ops от всех уникальных кошельков, держащих lending в этом протоколе.
              const walletIds = new Set(lendingPositions.map((pp) => pp.walletId));
              const ops: ClassifiedOp[] = [];
              for (const wid of walletIds) {
                const wOps = opsByWalletId.get(wid) ?? [];
                ops.push(...wOps);
              }
              const protocolAgg = computeProtocolBorrowAggregates(
                lendingPositions,
                ops,
              );
              return p.positions.map((pos, i) => (
                <PositionDetail
                  key={i}
                  pos={pos}
                  index={i + 1}
                  total={p.positions.length}
                  protocolAgg={protocolAgg}
                  locale={locale}
                  compositions={compositions}
                  onConfigureComposition={onConfigureComposition}
                  aaveReserveConfigs={aaveReserveConfigs}
                  walletOps={opsByWalletId.get(pos.walletId) ?? []}
                />
              ));
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}

function LendingDetail({
  lending,
  liquidationPrice,
  mainSupplySymbol,
  currentPrice,
  locale,
  assetLiquidationPrices,
}: {
  lending: NonNullable<ProtocolBreakdown["lending"]>;
  liquidationPrice: number | null;
  mainSupplySymbol: string | null;
  currentPrice: number | null;
  locale: "en" | "ru";
  /**
   * Per-asset ликв. цены для multi-collateral позиций (POS-007: WETH+WBTC).
   * Если массив >1 — popup рендерит блок «Залоговые активы» с per-asset
   * карточками вместо встраивания отдельных метрик в общий грид.
   */
  assetLiquidationPrices?: {
    symbol: string;
    amount: number;
    usdValue: number;
    weight: number;
    currentPrice: number | null;
    liquidationPrice: number | null;
    dropPct: number | null;
    /** LT использованный в расчёте (для tooltip), 0..1. null = uniform fallback. */
    ltUsed?: number | null;
    ltvUsed?: number | null;
    backsDebtUsd?: number | null;
  }[];
}) {
  const hf = lending.healthFactor;
  // Цвет всего блока зависит от HF: <1.3 — опасность (red), <1.6 — внимание
  // (orange), ≥1.6 — здоровый (green). Без HF — нейтральный.
  const status =
    hf == null
      ? {
          chrome: "border-border/60 bg-secondary/40",
          header: "text-muted-foreground",
          headerBorder: "border-border/40",
        }
      : hf < 1.3
        ? {
            chrome: "border-destructive/40 bg-destructive/10",
            header: "text-destructive",
            headerBorder: "border-destructive/30",
          }
        : hf < 1.6
          ? {
              chrome: "border-warning/40 bg-warning/10",
              header: "text-warning",
              headerBorder: "border-warning/30",
            }
          : {
              chrome: "border-success/40 bg-success/10",
              header: "text-success",
              headerBorder: "border-success/30",
            };
  const hfTextColor =
    hf == null
      ? "text-muted-foreground"
      : hf < 1.3
        ? "text-destructive"
        : hf < 1.6
          ? "text-warning"
          : "text-success";

  // Падение цены до ликвидации, %
  const dropPct =
    liquidationPrice != null && currentPrice != null && currentPrice > 0
      ? ((currentPrice - liquidationPrice) / currentPrice) * 100
      : null;

  return (
    <div className={cn("rounded-md border p-2", status.chrome)}>
      <div
        className={cn(
          "mb-1.5 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider",
          status.header,
        )}
      >
        <Landmark className="h-3 w-3" />
        Параметры займа
        {hf != null && (
          <span className="ml-auto text-[9px] font-medium normal-case opacity-80">
            {hf >= 1.6
              ? "Здоровая"
              : hf >= 1.3
                ? "Внимание"
                : "Опасность"}
          </span>
        )}
      </div>
      {/* GLOBAL: метрики применимые ко ВСЕЙ позиции (HF, запас, % по займу,
          можно занять). Per-asset метрики (цена ликв., LT, weight) выносятся
          ниже в блок «Залоговые активы» когда supply > 1. */}
      {(() => {
        const isMulti =
          assetLiquidationPrices && assetLiquidationPrices.length > 1;
        return (
          <div
            className={cn(
              "grid gap-1.5 grid-cols-2",
              isMulti ? "sm:grid-cols-4" : "sm:grid-cols-3 lg:grid-cols-5",
            )}
          >
            <LendingMetric
              label="Health Factor"
              value={hf != null ? hf.toFixed(2) : "—"}
              accent={hfTextColor}
              tooltip="HF = (collateral × LT) / debt. Если < 1 — позиция ликвидируется."
            />
            <LendingMetric
              label="Запас до ликв."
              value={
                lending.liquidationBufferPct != null
                  ? `${lending.liquidationBufferPct.toFixed(1)}%`
                  : "—"
              }
              accent={
                lending.liquidationBufferPct != null &&
                lending.liquidationBufferPct < 25
                  ? "text-destructive"
                  : "text-foreground"
              }
              tooltip="(1 − 1/HF) × 100. На сколько % залог может упасть до HF=1."
            />
            {!isMulti && (
              <LendingMetric
                label={
                  mainSupplySymbol
                    ? `Цена ликв. ${mainSupplySymbol}`
                    : "Цена ликвидации"
                }
                value={
                  liquidationPrice != null
                    ? formatUsd(liquidationPrice, locale)
                    : "—"
                }
                accent={hfTextColor}
                tooltip="Цена залогового актива, при которой HF=1. Формула: текущая_цена / HF."
                sub={
                  dropPct != null
                    ? `−${dropPct.toFixed(1)}% от текущей`
                    : currentPrice != null
                      ? `текущая ${formatUsd(currentPrice, locale)}`
                      : undefined
                }
              />
            )}
            <LendingMetric
              label="% по займу (накопл.)"
              value={formatUsd(lending.accruedInterestUsd, locale)}
              accent={
                lending.accruedInterestUsd > 0
                  ? "text-destructive"
                  : "text-foreground"
              }
              tooltip="(текущий долг − net_borrowed) × текущая цена. Net = Σ borrow − Σ repay. У нескольких позиций с одним debt-токеном % разделяется пропорционально доле."
              sub={
                lending.borrowAprPct != null && lending.borrowAprPct > 0
                  ? `APR ${lending.borrowAprPct.toFixed(2)}%`
                  : undefined
              }
            />
            <LendingMetric
              label="Можно занять ещё"
              value={
                lending.borrowRoomUsd != null
                  ? formatUsd(lending.borrowRoomUsd, locale)
                  : "—"
              }
              accent="text-foreground"
              tooltip="debt × (HF − 1) — сколько ещё USD можно занять до HF=1."
            />
          </div>
        );
      })()}

      {/* Залоговые активы: per-asset карточки для multi-collateral. Каждая
          карточка показывает amount, текущую цену, цену ликв., запас до ликв.,
          вес в общем залоге и LT (если on-chain загружен). */}
      {assetLiquidationPrices && assetLiquidationPrices.length > 1 && (
        <div className="mt-2">
          <div
            className={cn(
              "mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider",
              status.header,
            )}
          >
            <span className="inline-block h-3 w-0.5 rounded bg-brand-gradient" />
            Залоговые активы
            <span className="ml-auto text-[9px] font-medium normal-case opacity-80">
              {assetLiquidationPrices.length} актива · «изолированный» сценарий
            </span>
          </div>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {assetLiquidationPrices.map((a) => (
              <CollateralAssetCard
                key={a.symbol}
                asset={a}
                hfTextColor={hfTextColor}
                statusHeader={status.header}
                statusBorder={status.headerBorder}
                locale={locale}
              />
            ))}
          </div>
        </div>
      )}
      {lending.borrows.length > 0 && (
        <div
          className={cn(
            "mt-2 border-t pt-1.5",
            status.headerBorder,
          )}
        >
          <div
            className={cn(
              "mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider",
              status.header,
            )}
          >
            <span className="inline-block h-3 w-0.5 rounded bg-destructive" />
            Заёмы
            <span className="ml-auto text-[9px] font-medium normal-case opacity-80">
              {lending.borrows.length}{" "}
              {lending.borrows.length === 1 ? "актив" : "активов"}
            </span>
          </div>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {lending.borrows.map((b, i) => (
              <DebtAssetCard key={i} borrow={b} locale={locale} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Карточка одного залогового актива в multi-collateral позиции.
 * Использует brand-стиль: тонкий border, полупрозрачный фон того же цвета
 * что родительский контейнер (status.chrome), gradient-акцент на левой
 * границе, structured layout — header с символом и долей, две строки
 * метрик (текущая цена / цена ликв. / запас).
 */
function CollateralAssetCard({
  asset,
  hfTextColor,
  statusHeader,
  statusBorder,
  locale,
}: {
  asset: {
    symbol: string;
    amount: number;
    usdValue: number;
    weight: number;
    currentPrice: number | null;
    liquidationPrice: number | null;
    dropPct: number | null;
    ltUsed?: number | null;
  };
  hfTextColor: string;
  statusHeader: string;
  statusBorder: string;
  locale: "en" | "ru";
}) {
  const liqLabel =
    asset.liquidationPrice != null
      ? formatUsd(asset.liquidationPrice, locale)
      : "—";
  const dropLabel =
    asset.dropPct != null ? `−${asset.dropPct.toFixed(1)}%` : "—";
  const isImpossible = asset.liquidationPrice == null;
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md border bg-card/50 p-2",
        statusBorder,
      )}
    >
      {/* Brand-gradient accent на левой границе */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-brand-gradient"
      />
      {/* Header: 2 компактные строки */}
      <div className="mb-1.5">
        <div className="flex items-center justify-between gap-2">
          <span
            className={cn(
              "text-sm font-bold uppercase tracking-tight",
              statusHeader,
            )}
          >
            {asset.symbol}
          </span>
          <div className="flex shrink-0 items-center gap-1 text-[9px]">
            <span
              className="rounded bg-secondary/60 px-1 py-0.5 font-bold text-brand-cyan tabular-nums"
              title="Доля от общего залога (по USD стоимости)"
            >
              {(asset.weight * 100).toFixed(1)}%
            </span>
            {asset.ltUsed != null && (
              <span
                className="rounded bg-secondary/60 px-1 py-0.5 font-semibold tabular-nums text-muted-foreground"
                title={`Aave V3 Liquidation Threshold = ${(asset.ltUsed * 100).toFixed(2)}%`}
              >
                LT {(asset.ltUsed * 100).toFixed(0)}%
              </span>
            )}
          </div>
        </div>
        <div className="text-[10px] tabular-nums text-muted-foreground leading-tight">
          {formatNumber(asset.amount, locale, 6)}
          <span className="opacity-50"> · </span>
          {formatUsd(asset.usdValue, locale)}
        </div>
      </div>
      {/* Метрики: текущая цена · цена ликв. · запас */}
      <div className="grid grid-cols-3 gap-1">
        <CollateralMetric
          label="Текущая"
          value={
            asset.currentPrice != null
              ? formatUsd(asset.currentPrice, locale)
              : "—"
          }
        />
        <CollateralMetric
          label="Цена ликв."
          value={liqLabel}
          accent={isImpossible ? "text-muted-foreground" : hfTextColor}
          highlight={!isImpossible}
        />
        <CollateralMetric
          label="Запас"
          value={dropLabel}
          accent={isImpossible ? "text-muted-foreground" : hfTextColor}
          sub={
            isImpossible ? "не достижима" : undefined
          }
        />
      </div>
      {/* Обеспечивает долг — LTV-weighted pro-rata. Показываем только если
          есть долг и >0 атрибутировано. Это виртуальная attribution
          (Aave V3 cross-collateralized), отражает borrow capacity актива. */}
    </div>
  );
}

function CollateralMetric({
  label,
  value,
  accent,
  highlight,
  sub,
}: {
  label: string;
  value: string;
  accent?: string;
  highlight?: boolean;
  sub?: string;
}) {
  return (
    <div
      className={cn(
        "rounded px-1.5 py-1",
        highlight ? "bg-secondary/40 ring-1 ring-border/60" : "bg-secondary/20",
      )}
    >
      <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 text-[13px] font-bold tabular-nums leading-tight",
          accent ?? "text-foreground",
        )}
      >
        {value}
      </div>
      {sub && (
        <div className="text-[9px] text-muted-foreground italic leading-tight">
          {sub}
        </div>
      )}
    </div>
  );
}

/**
 * Карточка одного заёма (debt-актива) в lending-позиции.
 * Стиль зеркальный к `CollateralAssetCard`, но с destructive-акцентом
 * (красный gradient слева вместо brand-cyan).
 *
 * Раскладка:
 *   Header: [SYMBOL]      [APR pill]   [возраст]
 *           amount netto · оригинальная USD-стоимость на момент займа
 *   3 metric блока:
 *     - Стартовая ($X в момент первого borrow)
 *     - Текущая  ($Y сейчас, с учётом накопл. % и движения цены)
 *     - Накопл. % ($Z = current − net_borrowed × current_price)
 */
function DebtAssetCard({
  borrow,
  locale,
}: {
  borrow: import("@/lib/dashboard/metrics").BorrowInterest;
  locale: "en" | "ru";
}) {
  const fmt = (n: number) => formatUsd(n, locale);
  const apr = borrow.borrowAprPct;
  const aprColor =
    apr == null
      ? "text-muted-foreground"
      : apr >= 8
        ? "text-destructive"
        : apr >= 4
          ? "text-warning"
          : "text-foreground";
  return (
    <div className="relative overflow-hidden rounded-md border border-destructive/30 bg-destructive/5 p-2">
      {/* Destructive accent strip слева */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-destructive"
      />
      {/* Header: 2 компактные строки */}
      <div className="mb-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-bold uppercase tracking-tight text-destructive">
            {borrow.symbol}
          </span>
          <div className="flex shrink-0 items-center gap-1 text-[9px]">
            {apr != null && (
              <span
                className={cn(
                  "rounded bg-secondary/60 px-1 py-0.5 font-bold tabular-nums",
                  aprColor,
                )}
                title={`Borrow APR — годовая ставка по займу. APR = (current_debt − net_borrowed × current_price) / principal × 365 / age × 100`}
              >
                APR {apr.toFixed(2)}%
              </span>
            )}
            {borrow.ageDays != null && (
              <span className="rounded bg-secondary/60 px-1 py-0.5 font-medium tabular-nums text-muted-foreground">
                {borrow.ageDays.toFixed(0)} дн.
              </span>
            )}
          </div>
        </div>
        <div className="text-[10px] tabular-nums text-muted-foreground leading-tight">
          {formatNumber(borrow.netBorrowedAmount, locale, 4)} {borrow.symbol}
          <span className="opacity-50"> · net занято</span>
        </div>
      </div>

      {/* 3-колоночный grid метрик */}
      <div className="grid grid-cols-3 gap-1">
        <CollateralMetric
          label="Стартовая"
          value={fmt(borrow.originalPrincipalUsd)}
          sub="на момент borrow"
        />
        <CollateralMetric
          label="Текущая"
          value={fmt(borrow.currentDebtUsd)}
          accent="text-destructive"
          highlight
          sub="к возврату сейчас"
        />
        <CollateralMetric
          label="Накопл. %"
          value={`+${fmt(borrow.accruedInterestUsd)}`}
          accent={
            borrow.accruedInterestUsd > 0
              ? "text-destructive"
              : "text-muted-foreground"
          }
          sub={
            borrow.originalPrincipalUsd > 0
              ? `${((borrow.accruedInterestUsd / borrow.originalPrincipalUsd) * 100).toFixed(2)}% от стартовой`
              : undefined
          }
        />
      </div>
    </div>
  );
}

function LendingMetric({
  label,
  value,
  accent,
  sub,
  tooltip,
}: {
  label: string;
  value: string;
  accent: string;
  sub?: string;
  tooltip?: string;
}) {
  return (
    <div className="rounded-md border border-border bg-card/80 px-2 py-1.5">
      {/* Компактная шкала: label 9px, value 14px, sub 10px */}
      <div className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span className="truncate">{label}</span>
        {tooltip && (
          <Tooltip
            maxWidth={280}
            content={<div className="text-[11px]">{tooltip}</div>}
          >
            <span className="ml-auto cursor-help text-muted-foreground/70 hover:text-foreground">
              <Info className="h-2.5 w-2.5" />
            </span>
          </Tooltip>
        )}
      </div>
      <div
        className={cn(
          "mt-0.5 text-sm font-bold tabular-nums leading-tight",
          accent,
        )}
      >
        {value}
      </div>
      {sub && (
        <div className="text-[10px] font-medium tabular-nums text-muted-foreground leading-tight">
          {sub}
        </div>
      )}
    </div>
  );
}

function PositionDetail({
  pos,
  index,
  total,
  protocolAgg,
  locale,
  compositions,
  onConfigureComposition,
  aaveReserveConfigs,
  walletOps,
}: {
  pos: OpenPosition;
  index: number;
  total: number;
  protocolAgg: ProtocolBorrowAggregate;
  locale: "en" | "ru";
  compositions: import("@/lib/portfolio/asset_composition").AssetCompositions;
  /** Map для exact per-asset LT (Aave V3). Если пусто — uniform-LT fallback. */
  aaveReserveConfigs: AaveReserveConfigMap;
  onConfigureComposition: (symbol: string, scope?: string, label?: string) => void;
  /** Все ops кошелька этой позиции — для построения per-position timeline. */
  walletOps: ClassifiedOp[];
}) {
  // Per-position timeline: список ops которые сформировали эту позицию.
  // Junk автоматически отфильтрован внутри buildPositionTimeline.
  const timeline = useMemo(
    () => buildPositionTimeline(pos, walletOps),
    [pos, walletOps],
  );
  // Lifetime fees для visual display в Fee badge (raw pending + claimed).
  // Total PnL расчёт ниже использует `totalAssetsOf` — учитывает supply_yield
  // double-count (Aave currentUsd УЖЕ содержит accrued yield).
  const feesLifetimeUsd = (pos.feesUsd ?? 0) + pos.feesClaimedUsd;
  const pnlUsd =
    pos.startUsd > 0 ? totalAssetsOf(pos) - pos.startUsd : null;
  const pnlPct =
    pnlUsd != null && pos.startUsd > 0 ? (pnlUsd / pos.startUsd) * 100 : null;
  const positive = (pnlUsd ?? 0) >= 0;

  // Per-position lending метрики (HF, LTV, room, %, цена ликвидации).
  const lending: LendingMetrics | null =
    pos.kind === "lending"
      ? computePositionLendingMetrics(pos, protocolAgg)
      : null;

  // Цена ликвидации per supply-asset (Aave V3 / Fluid могут иметь
  // несколько collateral'ов, например WETH+WBTC у POS-007).
  //
  // **ТОЧНАЯ формула** (Aave V3, с per-asset LT'ами):
  //   HF = Σ (supply_i × price_i × LT_i) / debt
  //   Если только price_k меняется → liq_price_k:
  //     liq_price_k × LT_k × supply_k = debt - Σ_{i≠k} supply_i × price_i × LT_i
  //     liq_price_k = (debt - sum_others_lt) / (LT_k × supply_k)
  //
  // **Fallback uniform LT** (если Aave LT не загружены):
  //   drop_k = (1 - 1/HF) / weight_k
  //   liq_price_k = current_price_k × (1 - drop_k)
  const isAaveV3 = /aave\s*v?3/i.test(pos.protocol.name);
  const totalSupplyUsd = pos.supplyTokens.reduce(
    (s, t) => s + (t.currentUsd > 0 ? t.currentUsd : 0),
    0,
  );
  const debtUsd = pos.currentDebtUsd;
  // Получаем LT и LTV для каждого supply asset'а (если Aave V3 + tokenId).
  function getCfg(
    t: OpenPosition["supplyTokens"][number],
  ): { lt: number; ltv: number } | null {
    if (!isAaveV3 || !t.tokenId) return null;
    const cfg = aaveReserveConfigs.get(
      aaveReserveConfigKey(pos.chain, t.tokenId),
    );
    if (!cfg) return null;
    return { lt: cfg.liquidationThreshold, ltv: cfg.ltv };
  }
  // Для exact-LT формулы нужны LT'ы у ВСЕХ supply'ов. Если хоть один
  // не загружен — fallback на uniform.
  const supplyWithCurrent = pos.supplyTokens.filter(
    (t) => t.amount > 0 && t.currentUsd > 0,
  );
  const cfgs = supplyWithCurrent.map(getCfg);
  const ltsOnly = cfgs.map((c) => c?.lt ?? null);
  const ltvsOnly = cfgs.map((c) => c?.ltv ?? null);
  const useExactLT =
    isAaveV3 &&
    ltsOnly.every((lt) => lt != null && lt > 0) &&
    debtUsd > 0 &&
    supplyWithCurrent.length > 0;
  // Total borrow capacity (LTV-weighted) — для pro-rata атрибуции долга.
  // Если LTV есть для всех — используем LTV; иначе fallback на USD-вес.
  const useExactLTV = ltvsOnly.every((v) => v != null && v > 0);
  const totalBorrowCapacityUsd = useExactLTV
    ? supplyWithCurrent.reduce(
        (s, t, i) => s + t.currentUsd * (ltvsOnly[i] ?? 0),
        0,
      )
    : totalSupplyUsd;
  const assetLiquidationPrices: {
    symbol: string;
    /** Кол-во актива в позиции (live). */
    amount: number;
    /** Текущая USD-стоимость актива в позиции. */
    usdValue: number;
    /** Доля 0..1 от total collateral. */
    weight: number;
    currentPrice: number | null;
    liquidationPrice: number | null;
    dropPct: number | null;
    /** LT использованный в расчёте, 0..1. null = uniform fallback. */
    ltUsed: number | null;
    /** LTV (loan-to-value) этого актива, 0..1. Для расчёта borrow capacity. */
    ltvUsed: number | null;
    /** Сколько USD долга этот актив "обеспечивает" (LTV-weighted pro-rata). */
    backsDebtUsd: number | null;
  }[] =
    lending?.healthFactor != null &&
    lending.healthFactor > 0 &&
    totalSupplyUsd > 0
      ? supplyWithCurrent.map((t, idx) => {
          const cur = t.currentUsd / t.amount;
          const weight = t.currentUsd / totalSupplyUsd;
          const lt = ltsOnly[idx];
          let liq: number | null;
          let dropFrac: number | null;
          if (useExactLT && lt != null) {
            // sum_others_lt = Σ_{i≠k} supply_i_USD × LT_i (current prices)
            let sumOthersLt = 0;
            for (let j = 0; j < supplyWithCurrent.length; j++) {
              if (j === idx) continue;
              const otherLt = ltsOnly[j];
              if (otherLt == null) continue;
              sumOthersLt += supplyWithCurrent[j]!.currentUsd * otherLt;
            }
            // liq_price_k = (debt - sum_others_lt) / (LT_k × supply_k_amount)
            const numerator = debtUsd - sumOthersLt;
            const denominator = lt * t.amount;
            if (denominator > 0 && numerator > 0) {
              liq = numerator / denominator;
              dropFrac = (cur - liq) / cur;
              if (dropFrac < 0) {
                // liq > current — невозможно (asset уже под угрозой), clamp.
                liq = null;
                dropFrac = null;
              }
            } else {
              // numerator <= 0: с текущими ценами других asset'ов LT их
              // одних хватает покрыть долг → liquidation по asset_k
              // изолированно недостижима.
              liq = null;
              dropFrac = null;
            }
          } else {
            // Fallback uniform LT.
            const dropU = (1 - 1 / lending.healthFactor!) / weight;
            liq = dropU > 1 ? null : cur * (1 - dropU);
            dropFrac = liq != null ? dropU : null;
          }
          // Сколько USD долга "обеспечивает" этот актив (LTV-weighted pro-rata).
          // capacity_k = supply_k_USD × LTV_k
          // backsDebt_k = debt × capacity_k / Σ capacity
          const ltv = ltvsOnly[idx];
          let backsDebtUsd: number | null = null;
          if (debtUsd > 0 && totalBorrowCapacityUsd > 0) {
            const capacity = useExactLTV && ltv != null
              ? t.currentUsd * ltv
              : t.currentUsd; // fallback: USD-weight
            backsDebtUsd = debtUsd * (capacity / totalBorrowCapacityUsd);
          }
          return {
            symbol: t.symbol,
            amount: t.amount,
            usdValue: t.currentUsd,
            weight,
            currentPrice: cur,
            liquidationPrice: liq,
            dropPct: dropFrac != null ? dropFrac * 100 : null,
            ltUsed: useExactLT ? (lt ?? null) : null,
            ltvUsed: useExactLTV ? (ltv ?? null) : null,
            backsDebtUsd,
          };
        })
      : [];
  // Для single-collateral compatibility (legacy mainSupplySymbol/liquidationPrice).
  const mainSupply =
    pos.supplyTokens.length > 0
      ? pos.supplyTokens.reduce(
          (best, t) => (t.currentUsd > best.currentUsd ? t : best),
          pos.supplyTokens[0]!,
        )
      : null;
  const mainCurrentPrice =
    mainSupply && mainSupply.amount > 0
      ? mainSupply.currentUsd / mainSupply.amount
      : null;
  const liquidationPrice =
    assetLiquidationPrices.length === 1
      ? assetLiquidationPrices[0]!.liquidationPrice
      : lending?.healthFactor != null &&
          lending.healthFactor > 0 &&
          mainCurrentPrice != null
        ? mainCurrentPrice / lending.healthFactor
        : null;

  // Понятное название позиции:
  //  — у inferred (реконструировано из истории) показываем тип позиции
  //    (LP / Lending / Staking) вместо немотивирующего «Из истории»;
  //  — у live-позиций оставляем оригинальный itemName из протокола.
  const inferred = pos.inferred === true;
  const kindLabel: Record<string, string> = {
    lp: "Liquidity Pool",
    lending: "Lending",
    staking: "Staking",
    perp: "Perpetual",
    other: "Позиция",
  };
  // Inline-токены: «WBTC + USDC» / «ETH ↔ USD₮0» — компактное описание состава
  // позиции прямо в заголовке, чтобы убрать отдельный «Внесено/Занято» блок.
  const supplySymbols = pos.supplyTokens.map((t) => t.symbol).join(" + ");
  const debtSymbols = pos.debtTokens.map((t) => t.symbol).join(" + ");
  const tokensInline =
    pos.kind === "lending" && debtSymbols
      ? `${supplySymbols} ↔ ${debtSymbols}`
      : supplySymbols;

  const baseName = inferred
    ? (kindLabel[pos.kind] ?? "Позиция")
    : pos.itemName;
  // Нумеруем позиции если их > 1, чтобы было видно «Позиция 1 из 2».
  const displayName =
    total > 1 ? `${baseName} #${index}` : baseName;
  // Уникальный scope позиции — состав, заданный отсюда, не влияет на
  // другие позиции с тем же символом.
  const positionScope = positionOverrideKey({
    walletId: pos.walletId,
    chain: pos.chain,
    protocolId: pos.protocol.id,
    symbols: pos.supplyTokens.map((t) => t.symbol),
    ...(pos.instanceId && { instanceId: pos.instanceId }),
  });
  const scopeLabel = pos.id ?? displayName;

  // «Скрыть позицию» — для случаев когда live API возвращает закрытую
  // позицию с residual dust. Запись попадает в position_overrides.hidden,
  // и при следующем рендере openPositions она отфильтровывается до того,
  // как метрики дашборда успеют её учесть.
  const [, setPositionOverrides] = usePositionOverrides();
  const hidePosition = () => {
    if (
      !window.confirm(
        `Скрыть позицию «${displayName}»?\n\nИспользуйте если позиция реально закрыта on-chain, но API возвращает остаточные суммы. Скрыть можно из «Открытые позиции» → иконка глаза в колонке ID.`,
      )
    )
      return;
    setPositionOverrides((prev) => {
      const next = { ...prev };
      const cur = next[positionScope] ?? {};
      next[positionScope] = { ...cur, hidden: true };
      return next;
    });
  };
  return (
    <div
      className={cn(
        "rounded-lg border bg-card/80 shadow-sm",
        inferred ? "border-warning/30" : "border-border",
      )}
    >
      {/* Header полосой — название слева, токены по центру, метрики справа */}
      <div
        className={cn(
          "flex items-center justify-between gap-3 border-b px-3 py-2",
          inferred
            ? "border-warning/20 bg-warning/5"
            : "border-border/60 bg-secondary/30",
        )}
      >
        {/* Левая часть */}
        <div className="flex min-w-0 items-center gap-2">
          <div
            className={cn(
              "flex h-6 w-6 shrink-0 items-center justify-center rounded-md border",
              inferred
                ? "border-warning/40 bg-warning/10 text-warning"
                : "border-brand-cyan/30 bg-brand-cyan/10 text-brand-cyan",
            )}
          >
            {inferred ? (
              <HistoryIcon className="h-3 w-3" />
            ) : (
              <Coins className="h-3 w-3" />
            )}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-bold tracking-tight">
                {displayName}
              </span>
              {inferred && (
                <Badge
                  variant="warning"
                  className="h-4 shrink-0 px-1 text-[9px] uppercase"
                >
                  Из истории
                </Badge>
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  hidePosition();
                }}
                className="ml-auto inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/50 transition-colors hover:text-warning"
                title="Скрыть позицию (закрыта on-chain)"
              >
                <EyeOff className="h-3 w-3" />
              </button>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
              <span className="font-medium">{pos.walletName}</span>
              {pos.ageDays != null && (
                <>
                  <span className="opacity-50">·</span>
                  <span>{pos.ageDays} дн.</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Центр: бейдж токенов позиции — крупный и заметный */}
        {tokensInline && (
          <div className="hidden shrink-0 md:block">
            <div className="rounded-md border border-brand-cyan/30 bg-brand-cyan/5 px-3 py-1 text-center">
              <div className="flex items-center justify-center gap-1 text-[8px] font-medium uppercase tracking-wider text-muted-foreground">
                {pos.kind === "lending"
                  ? "Залог · Долг"
                  : pos.kind === "lp"
                    ? "Пул"
                    : "Актив"}
                {pos.supplyTokens.map((s) => {
                  const has =
                    compositions[`${positionScope}::${normalizeCompositionKey(s.symbol)}`] != null;
                  return (
                    <button
                      key={s.symbol}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onConfigureComposition(s.symbol, positionScope, scopeLabel);
                      }}
                      className={cn(
                        "ml-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded transition-colors",
                        has
                          ? "text-brand-cyan hover:text-brand-cyan/80"
                          : "text-muted-foreground/60 hover:text-foreground",
                      )}
                      title={
                        has
                          ? `Изменить состав ${s.symbol}`
                          : `Указать состав ${s.symbol}`
                      }
                    >
                      <Settings2 className="h-3 w-3" />
                    </button>
                  );
                })}
              </div>
              <div className="text-[13px] font-bold tracking-tight text-foreground">
                {tokensInline}
              </div>
            </div>
          </div>
        )}
        {/* Правая часть — компактные 3 столбца. Label 9px, value 14px (sm). */}
        <div className="flex shrink-0 items-stretch gap-2 text-right">
          <div className="border-r border-border/60 pr-2">
            <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
              {inferred ? "Внесено" : "Стоимость"}
            </div>
            <div className="text-sm font-bold tabular-nums leading-tight">
              {formatUsd(pos.currentUsd, locale)}
            </div>
          </div>
          {pos.currentDebtUsd > 0 && (
            <div className="border-r border-border/60 pr-2">
              <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                Долг
              </div>
              <div className="text-sm font-bold tabular-nums leading-tight text-destructive">
                −{formatUsd(pos.currentDebtUsd, locale)}
              </div>
            </div>
          )}
          {pnlUsd != null && pnlPct != null && (
            <div>
              <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                PnL
              </div>
              <div
                className={cn(
                  "text-sm font-bold tabular-nums leading-tight",
                  positive ? "text-success" : "text-destructive",
                )}
              >
                {positive ? "+" : ""}
                {formatUsd(pnlUsd, locale)}
              </div>
              <div
                className={cn(
                  "text-[10px] font-semibold tabular-nums leading-tight",
                  positive ? "text-success/80" : "text-destructive/80",
                )}
              >
                {positive ? "+" : ""}
                {pnlPct.toFixed(2)}%
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Body — рендерим только если есть что показать (lending detail,
          inferred-banner или pending награды). У простой staked/lp-позиции
          без debt и rewards body не отрисовывается → карточка остаётся
          компактной (только header). */}
      {(lending || inferred || pos.feesByToken.length > 0) && (
        <div className="space-y-3 p-3.5">
        {/* Информационный баннер для inferred-позиций */}
        {inferred && (
          <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-[11px] text-warning">
            <Info className="h-3.5 w-3.5 shrink-0" />
            <div className="space-y-0.5">
              <div className="font-semibold">
                Реконструировано из истории операций
              </div>
              <div className="text-warning/85">
                Live-данные для этого протокола недоступны. Текущая стоимость
                = сумма исторических депозитов по on-chain ценам. Реальная
                цена может отличаться — задайте её вручную через{" "}
                <a
                  href="/performance"
                  className="font-medium underline-offset-2 hover:underline"
                >
                  Лист открытых позиций
                </a>
                .
              </div>
            </div>
          </div>
        )}

        {/* Параметры займа per-position (только если эта позиция — lending) */}
        {lending && (
          <LendingDetail
            lending={lending}
            liquidationPrice={liquidationPrice}
            mainSupplySymbol={mainSupply?.symbol ?? null}
            currentPrice={mainCurrentPrice}
            locale={locale}
            assetLiquidationPrices={assetLiquidationPrices}
          />
        )}

        {/* Pending награды — единственное, что осталось в body, потому что
            это динамическая инфа (не дублирует токены из заголовка).
            Также показываем annualized APR от этих наград, если знаем срок. */}
        {pos.feesByToken.length > 0 && (
          <RewardsBlock
            tokens={pos.feesByToken.map((f) => ({
              symbol: f.symbol,
              amount: f.amount,
              usd: f.usd,
            }))}
            totalUsd={pos.feesUsd ?? 0}
            startUsd={pos.startUsd}
            ageDays={pos.ageDays}
            feeApr={pos.feeApr}
            feeAprLifetime={pos.feeAprLifetime}
            feesClaimedUsd={pos.feesClaimedUsd}
            locale={locale}
          />
        )}

        {/* Per-position timeline — chronology of ops that built this position. */}
        {timeline.events.length > 0 && (
          <PositionTimelineBlock
            timeline={timeline}
            locale={locale}
          />
        )}
        </div>
      )}
    </div>
  );
}

/**
 * UI блок: chronology событий по позиции. Открывается под Rewards.
 * Показывает каждое событие одной строкой: дата · тип (icon) · primary
 * amount · USD; кликабельный (TODO: drill-down в реестр).
 */
function PositionTimelineBlock({
  timeline,
  locale,
}: {
  timeline: import("@/lib/portfolio/position_timeline").PositionTimelineSummary;
  locale: "en" | "ru";
}) {
  // По умолчанию collapsed — пользователь сам открывает (как и сама позиция).
  const [expanded, setExpanded] = useState(false);
  const { events, totalDepositedUsd, totalWithdrawnUsd, totalClaimedUsd } =
    timeline;
  return (
    <div className="overflow-hidden rounded-md border border-border bg-secondary/20">
      {/* Кликабельный header — раскрывает/закрывает таблицу событий. */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:bg-secondary/40"
      >
        <ChevronDown
          className={cn(
            "h-3 w-3 transition-transform duration-200",
            !expanded && "-rotate-90",
          )}
        />
        <span className="inline-block h-3 w-0.5 rounded bg-brand-cyan" />
        История операций
        <span className="text-foreground/80">·</span>
        <span className="text-foreground">{events.length}</span>
        {/* Inline сводка чтобы было видно в свернутом виде */}
        <span className="ml-auto flex items-center gap-2 normal-case">
          {totalDepositedUsd > 0 && (
            <span className="text-[9px] font-medium tabular-nums text-foreground/70">
              внесено{" "}
              <span className="font-bold text-foreground">
                {formatUsd(totalDepositedUsd, locale)}
              </span>
            </span>
          )}
          {totalClaimedUsd > 0 && (
            <span className="text-[9px] font-medium tabular-nums text-success/70">
              собрано{" "}
              <span className="font-bold text-success">
                {formatUsd(totalClaimedUsd, locale)}
              </span>
            </span>
          )}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border/60 px-2 py-2">
          {/* Сводные cumulative цифры */}
          <div className="mb-2 grid grid-cols-3 gap-1.5 text-[10px]">
            <div className="rounded bg-card/60 px-1.5 py-1">
              <div className="font-semibold uppercase tracking-wider text-muted-foreground">
                Внесено
              </div>
              <div className="text-[12px] font-bold tabular-nums text-foreground">
                {formatUsd(totalDepositedUsd, locale)}
              </div>
            </div>
            <div className="rounded bg-card/60 px-1.5 py-1">
              <div className="font-semibold uppercase tracking-wider text-muted-foreground">
                Выведено
              </div>
              <div className="text-[12px] font-bold tabular-nums text-foreground">
                {formatUsd(totalWithdrawnUsd, locale)}
              </div>
            </div>
            <div className="rounded bg-card/60 px-1.5 py-1">
              <div className="font-semibold uppercase tracking-wider text-muted-foreground">
                Собрано
              </div>
              <div className="text-[12px] font-bold tabular-nums text-success">
                {formatUsd(totalClaimedUsd, locale)}
              </div>
            </div>
          </div>
          {/* Список событий */}
          <div className="grid grid-cols-[auto_auto_1fr_auto] gap-x-2 gap-y-1 text-[11px] tabular-nums">
            {events.map((e, idx) => (
              <Fragment key={idx}>
                <span className="text-[10px] text-muted-foreground">
                  {new Date(e.time * 1000).toLocaleDateString(
                    locale === "ru" ? "ru-RU" : "en-US",
                    { day: "2-digit", month: "2-digit", year: "2-digit" },
                  )}
                </span>
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider",
                    eventKindStyle(e.kind),
                  )}
                >
                  {timelineKindLabel(e.kind)}
                </span>
                <span className="truncate text-foreground/80">
                  {e.primaryAmount
                    ? `${formatNumber(e.primaryAmount.amount, locale, 4)} ${e.primaryAmount.symbol}`
                    : "—"}
                </span>
                <span className="text-right font-semibold text-foreground">
                  {e.primaryAmount && e.primaryAmount.usd > 0
                    ? formatUsd(e.primaryAmount.usd, locale)
                    : "—"}
                </span>
              </Fragment>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Цветовая дифференциация типов событий. */
function eventKindStyle(kind: PositionTimelineEvent["kind"]): string {
  switch (kind) {
    case "open":
      return "bg-brand-cyan/15 text-brand-cyan";
    case "increase":
      return "bg-brand-cyan/10 text-brand-cyan/90";
    case "decrease":
    case "close":
      return "bg-warning/10 text-warning";
    case "claim":
      return "bg-success/10 text-success";
    case "borrow":
      return "bg-destructive/10 text-destructive";
    case "repay":
      return "bg-success/10 text-success/90";
    default:
      return "bg-secondary/40 text-muted-foreground";
  }
}

function RewardsBlock({
  tokens,
  totalUsd,
  startUsd,
  ageDays,
  feeApr,
  feeAprLifetime,
  feesClaimedUsd,
  locale,
}: {
  tokens: { symbol: string; amount: number; usd: number }[];
  totalUsd: number;
  startUsd: number;
  ageDays: number | null;
  feeApr: number | null; // pending-only APR
  feeAprLifetime: number | null; // pending + claimed APR
  feesClaimedUsd: number;
  locale: "en" | "ru";
}) {
  return (
    <div className="rounded-md border border-success/30 bg-success/5 p-2">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-success" />
          <span className="text-[10px] font-bold uppercase tracking-wider text-success">
            Награды (pending)
          </span>
          <span className="text-[13px] font-bold tabular-nums text-success">
            {formatUsd(totalUsd, locale)}
          </span>
        </div>
        {feeAprLifetime != null && feeAprLifetime > 0 && (
          <Tooltip
            maxWidth={280}
            content={
              <div className="text-[11px] text-foreground/90">
                Годовая доходность от наград.{" "}
                <span className="font-mono">
                  APR = (награды / стартовый × 365 / срок) × 100
                </span>
                .{" "}
                {feeApr != null && (
                  <>
                    Pending {feeApr.toFixed(2)}%
                    {feesClaimedUsd > 0 && (
                      <>
                        {" + claimed → lifetime {feeAprLifetime.toFixed(2)}%"}
                      </>
                    )}
                    .
                  </>
                )}
              </div>
            }
          >
            <span className="inline-flex cursor-help items-center gap-1 rounded-full border border-success/40 bg-success/15 px-2 py-0.5 text-[10px] font-bold text-success">
              {feeAprLifetime.toFixed(2)}% APR
              <Info className="h-3 w-3" />
            </span>
          </Tooltip>
        )}
      </div>
      {/* Per-token breakdown: 4-колоночный grid (символ / amount / USD / APR) */}
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-2.5 gap-y-0.5 text-[11px] tabular-nums">
        <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
          Токен
        </div>
        <div className="text-right text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
          Amount
        </div>
        <div className="text-right text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
          USD
        </div>
        <div className="text-right text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
          APR
        </div>
        {tokens.map((l, i) => {
          const tokenApr =
            startUsd > 0 && ageDays != null && ageDays > 0
              ? (l.usd / startUsd) * (365 / ageDays) * 100
              : null;
          return (
            <Fragment key={i}>
              <span className="truncate font-bold">{l.symbol}</span>
              <span className="text-right text-muted-foreground">
                {formatNumber(l.amount, locale, 4)}
              </span>
              <span className="text-right font-bold text-success">
                {formatUsd(l.usd, locale)}
              </span>
              {tokenApr != null && tokenApr > 0 ? (
                <Tooltip
                  maxWidth={240}
                  content={
                    <div className="text-[11px] text-foreground/90">
                      APR от {l.symbol}: {tokenApr.toFixed(2)}%
                      <br />
                      <span className="font-mono opacity-80">
                        ({formatUsd(l.usd, locale)} /{" "}
                        {formatUsd(startUsd, locale)}) × 365 /{" "}
                        {ageDays?.toFixed(0)} дн.
                      </span>
                    </div>
                  }
                >
                  <span className="cursor-help justify-self-end rounded-full border border-success/30 bg-success/10 px-1.5 py-0.5 text-[10px] font-bold text-success">
                    {tokenApr.toFixed(2)}%
                  </span>
                </Tooltip>
              ) : (
                <span className="text-right text-[10px] italic text-muted-foreground">
                  —
                </span>
              )}
            </Fragment>
          );
        })}
      </div>
      {feesClaimedUsd > 0 && (
        <div className="mt-2 flex items-center justify-between border-t border-success/20 pt-2 text-[11px]">
          <span className="font-semibold text-muted-foreground">
            Уже снято (claimed)
          </span>
          <span className="flex items-baseline gap-2 tabular-nums">
            <span className="font-bold text-success">
              {formatUsd(feesClaimedUsd, locale)}
            </span>
            {ageDays != null && ageDays > 0 && (
              <span className="text-[10px] text-muted-foreground">
                за {ageDays.toFixed(0)} дн.
              </span>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

function PositionLines({
  title,
  lines,
  color,
  locale,
}: {
  title: string;
  lines: { symbol: string; amount: number; usd: number }[];
  color: "success" | "destructive";
  locale: "en" | "ru";
}) {
  const accentDot = color === "success" ? "bg-success" : "bg-destructive";
  const accentText =
    color === "success" ? "text-success" : "text-destructive";
  return (
    <div className="rounded-md border border-border bg-secondary/30 p-3">
      <div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
        <span className={cn("h-2 w-2 rounded-full", accentDot)} />
        {title}
      </div>
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-1 text-[12px] tabular-nums">
        {lines.map((l, i) => (
          <Fragment key={i}>
            <span className="truncate font-bold">{l.symbol}</span>
            <span className="text-right text-muted-foreground">
              {formatNumber(l.amount, locale, 4)}
            </span>
            <span className={cn("text-right font-bold", accentText)}>
              {formatUsd(l.usd, locale)}
            </span>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
