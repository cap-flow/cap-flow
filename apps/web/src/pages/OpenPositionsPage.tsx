/**
 * Лист открытых позиций.
 *
 * Источник правды — live-state (DeBank EVM, Helius/Vybe/Sonar SOL).
 * Каждая `LiveProtocolPosition` = одна строка таблицы (Fluid с двумя
 * сабпозициями = два ряда; GMX V2 LP WETH/USDC и WBTC/USDC = два ряда).
 *
 * Стартовая стоимость по supply-токенам считается через кумулятивную
 * средневзвешенную покупочную цену актива (Σ заплаченных стейблов /
 * Σ купленных amount за всё время этого кошелька).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { AlertTriangle, Archive, Eye, EyeOff, History, Info, Landmark, Loader2, Pencil, RefreshCw, Settings2, SlidersHorizontal, Wallet, X } from "lucide-react";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useLoadedWallets } from "@/components/data/LoadedWalletsProvider";
import { useT, useI18n } from "@/i18n/I18nProvider";
import { formatDateShort, formatNumber, formatUsd } from "@/i18n/format";
import {
  isV3LpProtocol,
  totalAssetsOf,
  type OpenPosition,
  type PositionKind,
} from "@/lib/portfolio/open_positions";
import { PurchaseHistoryPopup } from "@/components/PurchaseHistoryPopup";
import { useCexWithdrawalCostBasis } from "@/features/cex/hooks";
import type { CexCostBasisMatch } from "@/lib/portfolio/position_coverage";
import {
  MIN_START_USD_FOR_PCT,
  safePnlPct,
} from "@/lib/portfolio/display_pnl";
import { useWalletHistPrices } from "@/lib/portfolio/use_hist_prices";
import { useComputedPositions } from "@/lib/portfolio/use_computed_positions";
import { useLotMethodology } from "@/lib/lot_methodology";
import { LotMethodologyHelpDialog } from "@/components/LotMethodologyHelpDialog";
import { ColumnHelpDialog, hasColumnHelp } from "@/components/ColumnHelpDialog";
import { ColumnFilterDropdown } from "@/components/ui/ColumnFilterDropdown";
import {
  COLUMN_KIND,
  applyColumnSortFilter,
  distinctColumnValues,
  type CellContext,
  type RangeFilter,
  type SortDir,
} from "@/lib/portfolio/column_sort_filter";
import { useLocalStorage } from "@/lib/useLocalStorage";
import {
  defillamaCoinKey,
  fetchHistoricalPrices,
} from "@/lib/defillama";
import type { SavedWallet } from "@/lib/wallets";
import { useIntegrations } from "@/lib/integrations";
import {
  positionCreditKey,
  useCreditOverrides,
  type CreditOverrides,
} from "@/lib/portfolio/credit_overrides";
import {
  positionOverrideKey,
  usePositionOverrides,
  type PositionOverride,
  type PositionOverrides,
} from "@/lib/portfolio/position_overrides";
import { useV3Positions, v3PositionKey, type V3PositionMap } from "@/lib/v3/hook";
import { findV3Deployments } from "@/lib/v3/chains";
import type { V3Position } from "@/lib/v3/positions";
import { isStableSymbol } from "@/lib/portfolio/protocols";
import {
  expandByComposition,
  normalizeCompositionKey,
  useAssetCompositions,
  type AssetCompositions,
} from "@/lib/portfolio/asset_composition";
import { AssetCompositionDialog } from "@/components/portfolio/AssetCompositionDialog";
import { cn } from "@/lib/utils";
import { Chip } from "@/components/ui/Chip";
import { Tooltip } from "@/components/ui/Tooltip";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { AnimatedDonut, type DonutSegment } from "@/components/ui/AnimatedDonut";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { ColumnSettings } from "@/components/ui/ColumnSettings";
import {
  applyColumnPrefs,
  useColumnPrefs,
} from "@/lib/portfolio/column_prefs";
import { chainGroupOfWallet, CHAIN_GROUP_LABEL, type ChainGroup } from "@/lib/chain_groups";

const KIND_LABEL: Record<PositionKind, string> = {
  lending: "Лендинг",
  lp: "LP",
  staking: "Стейкинг",
  perp: "Perp",
  other: "Другое",
};

const KIND_BADGE: Record<PositionKind, string> = {
  lending: "bg-warning/15 text-warning border-warning/30",
  lp: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  staking: "bg-success/15 text-success border-success/30",
  perp: "bg-purple-500/15 text-purple-400 border-purple-500/30",
  other: "bg-muted text-muted-foreground border-border",
};

/* ---------------------------- Колонки таблицы ----------------------------- */

/**
 * Канонический список колонок таблицы открытых позиций.
 * `required: true` — нельзя скрыть. `align` — выравнивание шапки и ячейки.
 * Реальные render-функции живут в PositionRow и шапке (по `id`).
 */
const COLUMN_DEFS = [
  { id: "id", label: "ID", required: true, align: "center" as const },
  { id: "openedAt", label: "Дата открытия", align: "center" as const },
  { id: "ageDays", label: "Срок", align: "center" as const },
  { id: "wallet", label: "Кошелёк", align: "center" as const },
  { id: "chain", label: "Сеть", align: "center" as const },
  { id: "protocol", label: "Протокол", align: "center" as const },
  { id: "kind", label: "Тип", align: "center" as const },
  { id: "capital", label: "Капитал", align: "center" as const },
  { id: "tokenId", label: "TokenId / NFT", align: "center" as const },
  { id: "openedInToken", label: "Открыто в", align: "center" as const },
  { id: "openedInAmount", label: "Внесено токенов", align: "center" as const },
  { id: "supplyTokens", label: "Состав позиции", align: "center" as const },
  { id: "startUsd", label: "Стартовая $", align: "center" as const },
  { id: "currentUsd", label: "Текущая $", align: "center" as const },
  { id: "pnl", label: "PnL позиций", align: "center" as const },
  { id: "fee", label: "Fee", align: "center" as const },
  { id: "feeApr", label: "Fee APR", align: "center" as const },
  { id: "totalAssets", label: "Итого активы", align: "center" as const },
  { id: "totalPnl", label: "Total PnL", align: "center" as const },
  { id: "totalApr", label: "Total APR", align: "center" as const },
  { id: "weight", label: "Вес %", align: "center" as const },
] as const;

type ColumnId = (typeof COLUMN_DEFS)[number]["id"];

/* =================================== PAGE ================================= */

import { V3OverrideErrorBoundary } from "@/components/util/V3OverrideErrorBoundary";

export function OpenPositionsPage(): JSX.Element {
  return (
    <V3OverrideErrorBoundary>
      <OpenPositionsPageInner />
    </V3OverrideErrorBoundary>
  );
}

function OpenPositionsPageInner(): JSX.Element {
  const _t = useT();
  const { locale } = useI18n();
  const { loadedById, busyId, loadAll, costBasisOverrideByHash, newTrackers } =
    useLoadedWallets();
  const [integrations] = useIntegrations();
  const alchemyKey = (integrations.alchemyApiKey ?? "").trim();

  // UCB SoT: canonical position list (post-overrides) lives in
  // `useComputedPositions`. Local hooks below remain because downstream UI
  // (PurchaseHistoryPopup, V3 NFT rows, audit summary) consumes them
  // independently; the cost-basis pipeline itself is no longer rebuilt here.
  const computed = useComputedPositions();

  const loadedList = useMemo(
    () => Object.values(loadedById).sort((a, b) => a.loadedAt - b.loadedAt),
    [loadedById],
  );

  // CEX-withdrawal cost basis по tx-hash: позволяет атрибутировать
  // transfer_in события (с биржи) к реальному cost из WAC-пула на бирже
  // (P2P → trades → withdrawal). Без этого "куплено 3.2%" — остальное
  // числилось как "пришло без цены". Прокидываем в PurchaseHistoryPopup.
  const cexCostBasisQ = useCexWithdrawalCostBasis();
  const cexCostBasisByHash = useMemo(() => {
    const m = new Map<string, CexCostBasisMatch>();
    for (const c of cexCostBasisQ.data ?? []) {
      m.set(c.txHash.toLowerCase(), {
        costBasisUsd: c.costBasisUsd,
        source: c.source,
        asset: c.asset,
      });
    }
    return m;
  }, [cexCostBasisQ.data]);

  const v3 = useV3Positions(loadedList, alchemyKey);
  // Cost-basis hooks (V3 IncreaseLiquidity events, lending audit,
  // V3 mint pool/CoinGecko prices) живут внутри `useComputedPositions` —
  // здесь они больше не нужны. `useV3Positions` остаётся ради NFT-карточек
  // в таблице.
  const [creditOverrides, setCreditOverrides] = useCreditOverrides();
  const [positionOverrides, setPositionOverrides] = usePositionOverrides();
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
  const knownSymbols = useMemo(() => {
    const set = new Set<string>();
    for (const l of loadedList) {
      if (!l.live) continue;
      for (const t of l.live.tokens)
        if (t.amount > 0) set.add(normalizeCompositionKey(t.symbol));
    }
    return [...set].sort();
  }, [loadedList]);
  const [columnPrefs, setColumnPrefs] = useColumnPrefs();
  const visibleColumns = useMemo(
    () => applyColumnPrefs(COLUMN_DEFS, columnPrefs),
    [columnPrefs],
  );

  /* ---------- DefiLlama loading indicator для V3 lp_add tx ---------- */
  // `useComputedPositions` тянет точно такие же hist prices (для V3 lp_add
  // OUT-токенов), но без exposed loading. Здесь оставлен лёгкий effect
  // только чтобы зажечь "Загружаются исторические цены…" badge — данные
  // потребляются хуком pipeline (через кеш `fetchHistoricalPrices`).
  const [histLoading, setHistLoading] = useState(false);

  const histRequests = useMemo(() => {
    const items: { coin: string; timestamp: number }[] = [];
    const seen = new Set<string>();
    for (const l of loadedList) {
      if (!l.live) continue;
      const v3Protos = new Set(
        l.live.positions
          .filter((p) => isV3LpProtocol(p.protocolName))
          .map((p) => p.protocolId),
      );
      if (v3Protos.size === 0) continue;
      for (const op of l.ops) {
        if (op.status === "failed") continue;
        if (op.type !== "lp_add") continue;
        if (!op.protocol || !v3Protos.has(op.protocol.id)) continue;
        for (const m of op.movement) {
          if (m.direction !== "out" || m.amount <= 0) continue;
          const coin = defillamaCoinKey(op.chain, m.tokenId, m.symbol);
          if (!coin) continue;
          const key = `${coin}|${Math.floor(op.time / 3600)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          items.push({ coin, timestamp: op.time });
        }
      }
    }
    return items;
  }, [loadedList]);

  useEffect(() => {
    if (histRequests.length === 0) return;
    let cancelled = false;
    const ctrl = new AbortController();
    setHistLoading(true);
    void fetchHistoricalPrices(histRequests, ctrl.signal).finally(() => {
      if (!cancelled) setHistLoading(false);
    });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [histRequests]);

  // UCB SoT: см. useComputedPositions() выше — single canonical pipeline
  // (buildOpenPositions + V3 + Lending + CEX overrides).
  const positionsRaw = computed.positionsRaw;

  // Broad hist-prices Map (все non-stable in/out movements всех wallets) —
  // используется в PurchaseHistoryPopup и других downstream UI consumers.
  // Cost-basis pipeline сам тянет такой же map через useComputedPositions.
  const walletHistPrices = useWalletHistPrices(loadedList);

  // Глобальная lot-консумация методология (FIFO/LIFO/WAC) — общий setting
  // на всю страницу, persist в localStorage. Применяется к lending позициям.
  const [lotMethodology, setLotMethodology] = useLotMethodology();
  const [methodologyHelpOpen, setMethodologyHelpOpen] = useState(false);
  const [columnHelpId, setColumnHelpId] = useState<string | null>(null);

  // Применяем ручные метки «кредитная» поверх UCB canonical списка
  // (`computed.positions` уже содержит V3 + Lending + CEX overrides).
  // Когда currentValueUsd или feesUsd выставлены вручную — каскадно
  // пересчитываем `feesLifetimeUsd`, `feeAprLifetime` и Total APR.
  const positionsWithAlchemyOverride = useMemo(
    () =>
      computed.positions.map((p) => {
        const symbols = p.supplyTokens.map((t) => t.symbol);
        const instanceId = p.instanceId;
        const overrideK = positionOverrideKey({
          walletId: p.walletId,
          chain: p.chain,
          protocolId: p.protocol.id,
          symbols,
          ...(instanceId && { instanceId }),
        });
        const ov = positionOverrides[overrideK];
        let next = p;
        if (ov) {
          next = { ...p };
          if (ov.currentValueUsd != null && Number.isFinite(ov.currentValueUsd)) {
            next.currentUsd = ov.currentValueUsd;
          }
          if (ov.feesUsd != null && Number.isFinite(ov.feesUsd)) {
            next.feesUsd = ov.feesUsd;
            next.feesSource = next.feesSource ?? "v3_rewards";
          }
          next.feesLifetimeUsd = (next.feesUsd ?? 0) + next.feesClaimedUsd;
          next.feeAprLifetime =
            next.startUsd > 0 && next.ageDays && next.ageDays > 0
              ? (next.feesLifetimeUsd / next.startUsd) * (365 / next.ageDays) * 100
              : null;
          next.feeApr =
            next.feesUsd != null && next.startUsd > 0 && next.ageDays && next.ageDays > 0
              ? (next.feesUsd / next.startUsd) * (365 / next.ageDays) * 100
              : null;
        }
        const creditK = positionCreditKey({
          walletId: next.walletId,
          chain: next.chain,
          protocolId: next.protocol.id,
          symbols,
          ...(instanceId && { instanceId }),
        });
        if (creditOverrides[creditK]) {
          next = { ...next, creditFundedUsd: next.currentUsd };
        }
        return next;
      }),
    [computed.positions, creditOverrides, positionOverrides],
  );

  // Backward-compat alias: downstream code (hiddenKeys etc.) iterates
  // `positions`. UCB canonical + user overrides → one source.
  const positions = positionsWithAlchemyOverride;



  const togglePositionCredit = (p: OpenPosition) => {
    const instanceId = p.instanceId;
    const k = positionCreditKey({
      walletId: p.walletId,
      chain: p.chain,
      protocolId: p.protocol.id,
      symbols: p.supplyTokens.map((t) => t.symbol),
      ...(instanceId && { instanceId }),
    });
    setCreditOverrides((prev) => {
      const next: CreditOverrides = { ...prev };
      if (next[k]) delete next[k];
      else next[k] = true;
      return next;
    });
  };

  /** Обновить override (currentValueUsd / feesUsd) для позиции. `null` — снять. */
  const setPositionOverride = (
    p: OpenPosition,
    patch: Partial<PositionOverride>,
  ) => {
    const instanceId = p.instanceId;
    const k = positionOverrideKey({
      walletId: p.walletId,
      chain: p.chain,
      protocolId: p.protocol.id,
      symbols: p.supplyTokens.map((t) => t.symbol),
      ...(instanceId && { instanceId }),
    });
    setPositionOverrides((prev) => {
      const next: PositionOverrides = { ...prev };
      const merged: PositionOverride = { ...(next[k] ?? {}), ...patch };
      // Чистим undefined, чтобы не плодить пустые ключи.
      if (merged.currentValueUsd === undefined) delete merged.currentValueUsd;
      if (merged.feesUsd === undefined) delete merged.feesUsd;
      if (Object.keys(merged).length === 0) {
        delete next[k];
      } else {
        next[k] = merged;
      }
      return next;
    });
  };

  // PR #5 multi-select filters. Empty Set = «все» (no filter applied).
  // Toggle-on-click chip behavior. groupFilter остался single — это broad
  // dimension (evm/sol/coinstats), не имеет смысла мульти-выбора с walletFilter.
  const [walletFilter, setWalletFilter] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [kindFilter, setKindFilter] = useState<ReadonlySet<PositionKind>>(
    () => new Set(),
  );
  const [chainFilter, setChainFilter] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [protocolFilter, setProtocolFilter] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [groupFilter, setGroupFilter] = useState<ChainGroup | "all">("all");

  // PR #5 status toggles (boolean filters). Each independent.
  const [filterPnL, setFilterPnL] = useState<"all" | "profit" | "loss">("all");
  const [filterRange, setFilterRange] = useState<"all" | "in" | "out">("all");
  const [filterHasFee, setFilterHasFee] = useState(false);
  const [filterHasDebt, setFilterHasDebt] = useState(false);

  // Per-column сортировка + фильтры (Google-Sheets-style на заголовках).
  // Персистится в localStorage (переживает перезагрузку).
  const [sfPrefs, setSfPrefs] = useLocalStorage<{
    sortCol: string | null;
    sortDir: SortDir;
    valueFilters: Record<string, string[]>;
    rangeFilters: Record<string, RangeFilter>;
  }>("capflow.openPositions.sortFilter", {
    sortCol: null,
    sortDir: "desc",
    valueFilters: {},
    rangeFilters: {},
  });
  const sortCol = sfPrefs.sortCol;
  const sortDir = sfPrefs.sortDir;
  const colValueFilters = sfPrefs.valueFilters;
  const colRangeFilters = sfPrefs.rangeFilters ?? {};
  const setSortCol = (v: string | null) =>
    setSfPrefs((p) => ({ ...p, sortCol: v }));
  const setSortDir = (v: SortDir) => setSfPrefs((p) => ({ ...p, sortDir: v }));
  // Активны ли per-column сортировка/фильтры (для кнопки сброса — чтобы юзер
  // не застрял с пустой таблицей: фильтр персистится, reload не спасает).
  const anyColFilterActive =
    Object.values(colValueFilters).some((v) => v.length > 0) ||
    Object.values(colRangeFilters).some(
      (r) => r && (r.min != null || r.max != null),
    );
  const sortOrFilterActive = sortCol != null || anyColFilterActive;
  const resetSortFilter = () =>
    setSfPrefs({
      sortCol: null,
      sortDir: "desc",
      valueFilters: {},
      rangeFilters: {},
    });

  // Helper toggles for multi-select sets.
  function toggleInSet<T>(
    set: ReadonlySet<T>,
    item: T,
    setter: (s: ReadonlySet<T>) => void,
  ): void {
    const next = new Set(set);
    if (next.has(item)) next.delete(item);
    else next.add(item);
    setter(next);
  }

  // Кол-во загруженных кошельков по chain-группам — для бейджей в чипах.
  const groupCounts = useMemo(() => {
    const c: Record<ChainGroup, number> = { evm: 0, sol: 0, coinstats: 0 };
    for (const l of loadedList) c[chainGroupOfWallet(l.wallet)]++;
    return c;
  }, [loadedList]);

  // Скрытые позиции — пользовательские overrides + auto-detected closed.
  // Считаем кол-во скрытых, чтобы показать banner «Показать N скрытых».
  const [showHidden, setShowHidden] = useState(false);
  const hiddenKeys = useMemo(() => {
    const set = new Set<string>();
    for (const p of positions) {
      const instanceId = p.instanceId;
      const k = positionOverrideKey({
        walletId: p.walletId,
        chain: p.chain,
        protocolId: p.protocol.id,
        symbols: p.supplyTokens.map((t) => t.symbol),
        ...(instanceId && { instanceId }),
      });
      if (positionOverrides[k]?.hidden) set.add(p.id);
    }
    return set;
  }, [positions, positionOverrides]);

  function isHidden(p: OpenPosition): boolean {
    return hiddenKeys.has(p.id);
  }

  function toggleHidden(p: OpenPosition) {
    const instanceId = p.instanceId;
    const k = positionOverrideKey({
      walletId: p.walletId,
      chain: p.chain,
      protocolId: p.protocol.id,
      symbols: p.supplyTokens.map((t) => t.symbol),
      ...(instanceId && { instanceId }),
    });
    setPositionOverrides((prev) => {
      const next: PositionOverrides = { ...prev };
      const cur = next[k] ?? {};
      if (cur.hidden) {
        const { hidden: _h, ...rest } = cur;
        if (Object.keys(rest).length === 0) delete next[k];
        else next[k] = rest;
      } else {
        next[k] = { ...cur, hidden: true };
      }
      return next;
    });
  }

  // Map walletId → ops для popup'а истории покупок (передаётся в PositionRow).
  const opsByWalletId = useMemo(() => {
    const m = new Map<string, import("@/lib/portfolio/types").ClassifiedOp[]>();
    for (const l of loadedList) m.set(l.wallet.id, l.ops);
    return m;
  }, [loadedList]);

  // Single source of truth для popup'а истории покупок underlying. Хранит
  // p.id активной позиции (или null если popup закрыт). Это устраняет
  // возможные коллизии state'а когда было по popup'у на каждый PositionRow.
  const [activePurchasePositionId, setActivePurchasePositionId] = useState<
    string | null
  >(null);
  const activePurchasePosition = useMemo(
    () =>
      activePurchasePositionId
        ? positionsWithAlchemyOverride.find(
            (p) => p.id === activePurchasePositionId,
          ) ?? null
        : null,
    [activePurchasePositionId, positionsWithAlchemyOverride],
  );

  // Базовый набор: глобальные фильтры (FiltersDropdown + status toggles).
  const viewBase = positionsWithAlchemyOverride.filter((p) => {
    if (!showHidden && hiddenKeys.has(p.id)) return false;
    if (groupFilter !== "all") {
      const wallet = loadedList.find((l) => l.wallet.id === p.walletId)?.wallet;
      if (!wallet || chainGroupOfWallet(wallet) !== groupFilter) return false;
    }
    // Multi-select filters: empty Set = all (no constraint).
    if (walletFilter.size > 0 && !walletFilter.has(p.walletId)) return false;
    if (kindFilter.size > 0 && !kindFilter.has(p.kind)) return false;
    if (chainFilter.size > 0 && !chainFilter.has(p.chain)) return false;
    if (protocolFilter.size > 0 && !protocolFilter.has(p.protocol.id)) return false;
    // Status toggles (independent).
    if (filterPnL === "profit" && p.netPnlUsd <= 0) return false;
    if (filterPnL === "loss" && p.netPnlUsd >= 0) return false;
    if (filterRange === "in" && p.v3?.inRange === false) return false;
    if (filterRange === "out" && p.v3?.inRange !== false) return false;
    if (filterHasFee && (p.feesUsd ?? 0) <= 0) return false;
    if (filterHasDebt && p.currentDebtUsd <= 0) return false;
    return true;
  });

  // Контекст для per-column сортировки/фильтра. sumCurrentUsd = Σ по базовому
  // набору (знаменатель «Вес %»); используется и для distinct-списков значений.
  const cellCtx: CellContext = {
    sumCurrentUsd: viewBase.reduce((s, p) => s + p.currentUsd, 0),
    locale,
  };
  // Финальный набор для таблицы/аналитики: + per-column value-фильтры (членство)
  // и сортировка (порядок). Глобальная аналитика ниже считается по `view`.
  const view = applyColumnSortFilter(
    viewBase,
    { sortCol, sortDir, valueFilters: colValueFilters, rangeFilters: colRangeFilters },
    cellCtx,
  );

  // ─────────────────────────────────────────────────────────────────────
  //  V3 NFT → OpenPosition assignment
  //
  //  Каждая live позиция в одном пуле/паре (например, 2 WETH/USDC NFT в
  //  Uniswap V3 на arb) имеет свой NFT. v3PositionKey возвращает СПИСОК
  //  всех NFT'ов в этой паре, поэтому без явного assignment'а каждая
  //  позиция-строка показывала бы все 2 NFT'а (баг Alex 2026-05-08).
  //
  //  Делаем optimal assignment по amount-distance: для каждой группы
  //  (walletId, chain, deploymentId, sorted-pair) сортируем позиции и
  //  NFT'ы и матчим one-to-one по minimum total distance.
  // ─────────────────────────────────────────────────────────────────────
  const v3AssignedByPosId = useMemo<Map<string, import("@/lib/v3/positions").V3Position[]>>(() => {
    const out = new Map<string, import("@/lib/v3/positions").V3Position[]>();
    if (v3.data.size === 0) return out;
    type P = OpenPosition;
    type Nft = import("@/lib/v3/positions").V3Position;
    // Группируем live по (walletId, chain, deploymentId, sortedSymbols).
    // deploymentId выводим из protocolName + chain через findV3Deployments.
    const groups = new Map<string, { positions: P[]; nfts: Nft[] }>();
    for (const p of view) {
      if (!p.v3) continue;
      const deps = findV3Deployments(p.chain, p.protocol.name);
      for (const dep of deps) {
        const key = v3PositionKey({
          walletId: p.walletId,
          chain: p.chain,
          deploymentId: dep.id,
          symbols: p.supplyTokens.map((t) => t.symbol),
        });
        const nfts = v3.data.get(key) ?? [];
        if (nfts.length === 0) continue;
        const g = groups.get(key) ?? { positions: [], nfts };
        if (!groups.has(key)) g.nfts = nfts;
        g.positions.push(p);
        groups.set(key, g);
      }
    }
    function dist(p: P, n: Nft): number {
      // amount0/amount1 от Nft в порядке token0/token1 пула (отсортированном
      // по адресам). supplyTokens у OpenPosition в порядке от DeBank — может
      // не совпадать. Сматчим через нормализованный symbol.
      const sym0 = n.token0.symbol;
      const sym1 = n.token1.symbol;
      const sup0 = p.supplyTokens.find(
        (t) => t.symbol.toUpperCase() === sym0.toUpperCase() ||
          (sym0 === "WETH" && t.symbol.toUpperCase() === "ETH") ||
          (sym0 === "ETH" && t.symbol.toUpperCase() === "WETH"),
      );
      const sup1 = p.supplyTokens.find(
        (t) => t.symbol.toUpperCase() === sym1.toUpperCase() ||
          (sym1 === "WETH" && t.symbol.toUpperCase() === "ETH") ||
          (sym1 === "ETH" && t.symbol.toUpperCase() === "WETH"),
      );
      const a0 = sup0?.amount ?? 0;
      const a1 = sup1?.amount ?? 0;
      const d0 =
        a0 + n.amount0Current > 0
          ? Math.abs(a0 - n.amount0Current) / (a0 + n.amount0Current)
          : 0;
      const d1 =
        a1 + n.amount1Current > 0
          ? Math.abs(a1 - n.amount1Current) / (a1 + n.amount1Current)
          : 0;
      return d0 + d1;
    }
    // Brute-force optimal assignment для маленьких групп (<= 8 позиций).
    function assign(positions: P[], nfts: Nft[]): Map<string, Nft> {
      const result = new Map<string, Nft>();
      const k = Math.min(positions.length, nfts.length);
      if (k === 0) return result;
      if (k > 8) {
        // Greedy fallback.
        const used = new Set<number>();
        for (const p of positions) {
          let bestI = -1;
          let bestD = Infinity;
          for (let i = 0; i < nfts.length; i++) {
            if (used.has(i)) continue;
            const d = dist(p, nfts[i]!);
            if (d < bestD) {
              bestD = d;
              bestI = i;
            }
          }
          if (bestI >= 0) {
            result.set(p.id, nfts[bestI]!);
            used.add(bestI);
          }
        }
        return result;
      }
      let bestPerm: number[] = [];
      let bestSum = Infinity;
      const idx = [...Array(nfts.length).keys()];
      function recurse(picked: number[], avail: number[]): void {
        if (picked.length === k) {
          let sum = 0;
          for (let i = 0; i < k; i++) {
            sum += dist(positions[i]!, nfts[picked[i]!]!);
          }
          if (sum < bestSum) {
            bestSum = sum;
            bestPerm = [...picked];
          }
          return;
        }
        for (let i = 0; i < avail.length; i++) {
          recurse([...picked, avail[i]!], [
            ...avail.slice(0, i),
            ...avail.slice(i + 1),
          ]);
        }
      }
      recurse([], idx);
      for (let i = 0; i < bestPerm.length; i++) {
        result.set(positions[i]!.id, nfts[bestPerm[i]!]!);
      }
      return result;
    }
    for (const g of groups.values()) {
      const map = assign(g.positions, g.nfts);
      for (const [posId, nft] of map) {
        const arr = out.get(posId) ?? [];
        arr.push(nft);
        out.set(posId, arr);
      }
    }
    return out;
  }, [view, v3.data]);

  // Сводная аналитика — два блока: «По всем» и «По кредитным».
  const analyticsAll = useMemo(() => computeAnalytics(view), [view]);
  const creditView = useMemo(
    () => view.filter((p) => p.creditFundedUsd > 0),
    [view],
  );
  const analyticsCredit = useMemo(
    () => computeAnalytics(creditView),
    [creditView],
  );
  // Дополнительные суммы для шапки/совместимости.
  const currentTotal = analyticsAll.currentUsd;
  const debtTotal = view.reduce((s, p) => s + p.currentDebtUsd, 0);
  const creditCapital = view.reduce((s, p) => s + p.creditFundedUsd, 0);
  const ownCapital = analyticsAll.totalAssetsUsd - creditCapital;

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
            , чтобы построить лист открытых позиций.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <Header
        action={
          <div className="flex flex-wrap items-center gap-2">
            {histLoading && (
              <span className="rounded-md border border-border bg-secondary/40 px-2 py-1 text-[11px] text-brand-cyan">
                подтягиваю исторические цены V3…
              </span>
            )}
            {/* Глобальный lot methodology toggle. Влияет на Стартовая $
                lending позиций по всей странице (FIFO/LIFO/WAC). */}
            <div className="inline-flex items-center gap-1 rounded-md border border-brand-cyan/30 bg-brand-cyan/5 p-0.5 text-[11px]">
              <span className="px-1.5 text-muted-foreground">Lot:</span>
              {(["FIFO", "LIFO", "WAC"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setLotMethodology(m)}
                  className={cn(
                    "rounded px-1.5 py-0.5 font-semibold transition-colors",
                    lotMethodology === m
                      ? "bg-brand-cyan/20 text-brand-cyan"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  title={
                    m === "FIFO"
                      ? "First In, First Out — старые покупки уходят первыми. Рекомендуется."
                      : m === "LIFO"
                        ? "Last In, First Out — новые покупки уходят первыми."
                        : "Weighted Average — средневзвешенная цена всех lots."
                  }
                >
                  {m}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setMethodologyHelpOpen(true)}
                className="ml-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-brand-cyan/40 bg-brand-cyan/10 text-brand-cyan font-bold hover:bg-brand-cyan/20 transition-colors"
                title="Подробнее о методиках FIFO / LIFO / WAC"
              >
                ?
              </button>
            </div>
            <a
              href="/closed"
              className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary/40 px-2 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-brand-cyan/40 hover:text-foreground"
              title="Архив закрытых позиций"
            >
              <Archive className="h-3.5 w-3.5" />
              Архив
            </a>
            <Button
              size="sm"
              disabled={Boolean(busyId)}
              onClick={() => void loadAll()}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", busyId && "animate-spin")} />
              Обновить
            </Button>
          </div>
        }
      />

      {/* Сводная аналитика — сворачиваемая секция */}
      <CollapsibleSection
        storageKey="capflow.openPositions.analyticsOpen"
        headerVariant="brand"
        title={
          <div className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-full bg-background/80" />
            <h3 className="text-xs font-bold uppercase tracking-wider text-background">
              Аналитика
            </h3>
          </div>
        }
        rightSlot={
          <span className="rounded-full bg-background/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-background">
            {analyticsAll.positionCount}{" "}
            {analyticsAll.positionCount === 1 ? "позиция" : "позиций"}
          </span>
        }
      >
        <div className="space-y-3 p-3 pt-1">
          <AnalyticsBlock
            title="Сводка по всем открытым позициям"
            data={analyticsAll}
            accentGradient
          />
          {creditView.length > 0 && (
            <AnalyticsBlock
              title="Только кредитные позиции"
              data={analyticsCredit}
              accentDanger
            />
          )}
          <AssetStructureBlock positions={view} compositions={assetCompositions} />
        </div>
      </CollapsibleSection>

      {/* Column settings — фильтрация теперь через дропдауны в заголовках */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="ml-auto">
          <ColumnSettings
            columns={COLUMN_DEFS}
            hidden={columnPrefs.hidden}
            order={columnPrefs.order}
            onChange={setColumnPrefs}
          />
        </div>
      </div>

      {/* Table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <History className="h-4 w-4 text-brand-cyan" />
            Открытые позиции
            <Badge variant="muted" className="ml-2 text-[10px]">
              {view.length}
            </Badge>
            <div className="ml-auto flex items-center gap-2">
              {sortOrFilterActive && (
                <button
                  type="button"
                  onClick={resetSortFilter}
                  className="inline-flex items-center gap-1 rounded-md border border-brand-cyan/40 bg-brand-cyan/10 px-2 py-1 text-[10px] font-medium text-brand-cyan transition-colors hover:bg-brand-cyan/20"
                  title="Сбросить сортировку и все фильтры столбцов"
                >
                  <X className="h-3 w-3" />
                  Сбросить фильтры
                </button>
              )}
              {hiddenKeys.size > 0 && (
                <button
                  type="button"
                  onClick={() => setShowHidden((v) => !v)}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary/40 px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:border-brand-cyan/40 hover:text-foreground"
                  title={
                    showHidden
                      ? "Не показывать скрытые позиции"
                      : "Показать скрытые позиции"
                  }
                >
                  {showHidden ? (
                    <Eye className="h-3 w-3" />
                  ) : (
                    <EyeOff className="h-3 w-3" />
                  )}
                  {showHidden ? "Скрыть скрытые" : `+${hiddenKeys.size} скрытых`}
                </button>
              )}
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {view.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <p className="text-sm text-muted-foreground">
                {sortOrFilterActive
                  ? "Ничего не найдено по выбранным фильтрам столбцов."
                  : "Нет открытых позиций."}
              </p>
              {sortOrFilterActive && (
                <button
                  type="button"
                  onClick={resetSortFilter}
                  className="mt-3 inline-flex items-center gap-1 rounded-md border border-brand-cyan/40 bg-brand-cyan/10 px-3 py-1.5 text-xs font-medium text-brand-cyan transition-colors hover:bg-brand-cyan/20"
                >
                  <X className="h-3.5 w-3.5" />
                  Сбросить фильтры
                </button>
              )}
            </div>
          ) : (
            <div className="hidden md:block overflow-x-auto">
              {/*
                M12 (2026-05-14): give the table an explicit min-width
                proportional to its column count so phones render the
                actual layout (scrollable horizontally) instead of
                squishing columns into unreadable 6px-wide stripes.
                Default w-full was making columns collapse below
                readable thresholds on iPhone-SE-class widths.

                Mobile (< md): полностью отдельный card-view ниже —
                только ключевые поля (symbol, USD, PnL, fees), потому
                что 15-колоночная dynamic-таблица в карточки не
                умещается.
              */}
              <table
                className="w-full text-sm"
                style={{
                  minWidth: `${Math.max(720, visibleColumns.length * 110)}px`,
                }}
              >
                <thead className="border-y border-border bg-secondary/40 text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    {visibleColumns.map((c) => (
                      <Th key={c.id} align={c.align ?? "left"}>
                        <span
                          className={cn(
                            "inline-flex items-center gap-1",
                            c.align === "right" && "justify-end",
                            c.align === "center" && "justify-center",
                          )}
                        >
                          {c.label}
                          {hasColumnHelp(c.id) && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setColumnHelpId(c.id);
                              }}
                              className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-brand-cyan/50 bg-brand-cyan/15 text-[9px] font-bold text-brand-cyan hover:bg-brand-cyan/30 hover:border-brand-cyan transition-colors"
                              title={`Подробнее о колонке "${c.label}"`}
                            >
                              ?
                            </button>
                          )}
                          {c.id !== "capital" && (
                            <ColumnFilterDropdown
                              kind={COLUMN_KIND[c.id] ?? "text"}
                              sortDir={sortCol === c.id ? sortDir : null}
                              computeValues={() =>
                                distinctColumnValues(viewBase, c.id, cellCtx)
                              }
                              selected={colValueFilters[c.id] ?? null}
                              range={colRangeFilters[c.id] ?? null}
                              onSort={(dir) => {
                                setSortCol(c.id);
                                setSortDir(dir);
                              }}
                              onClearSort={() => setSortCol(null)}
                              onChangeSelected={(next) =>
                                setSfPrefs((prev) => {
                                  const copy = { ...prev.valueFilters };
                                  if (next === null) delete copy[c.id];
                                  else copy[c.id] = next;
                                  return { ...prev, valueFilters: copy };
                                })
                              }
                              onChangeRange={(next) =>
                                setSfPrefs((prev) => {
                                  const copy = { ...(prev.rangeFilters ?? {}) };
                                  if (next === null) delete copy[c.id];
                                  else copy[c.id] = next;
                                  return { ...prev, rangeFilters: copy };
                                })
                              }
                            />
                          )}
                        </span>
                      </Th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {view.map((p) => {
                    const symbols = p.supplyTokens.map((t) => t.symbol);
                    const instanceId = p.instanceId;
                    const k = positionCreditKey({
                      walletId: p.walletId,
                      chain: p.chain,
                      protocolId: p.protocol.id,
                      symbols,
                      ...(instanceId && { instanceId }),
                    });
                    const ovK = positionOverrideKey({
                      walletId: p.walletId,
                      chain: p.chain,
                      protocolId: p.protocol.id,
                      symbols,
                      ...(instanceId && { instanceId }),
                    });
                    const ov = positionOverrides[ovK];
                    return (
                      <PositionRow
                        key={p.id}
                        p={p}
                        v3Map={v3.data}
                        v3Assigned={v3AssignedByPosId.get(p.id) ?? null}
                        sumCurrentUsd={currentTotal}
                        creditOverrideOn={!!creditOverrides[k]}
                        onToggleCredit={() => togglePositionCredit(p)}
                        valueOverride={ov?.currentValueUsd ?? null}
                        feesOverride={ov?.feesUsd ?? null}
                        onSaveCurrentUsd={(n) => setPositionOverride(p, { currentValueUsd: n ?? undefined })}
                        onSaveFeesUsd={(n) => setPositionOverride(p, { feesUsd: n ?? undefined })}
                        columnIds={visibleColumns.map((c) => c.id)}
                        compositions={assetCompositions}
                        onConfigureComposition={openCompositionDialog}
                        hidden={isHidden(p)}
                        onToggleHidden={() => toggleHidden(p)}
                        onOpenPurchaseHistory={() =>
                          setActivePurchasePositionId(p.id)
                        }
                        v3CostBasisLoading={computed.v3CostBasisLoading}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Mobile: компактные карточки (только ключевые поля) */}
          {view.length > 0 && (
            <ul className="md:hidden divide-y divide-border border-y border-border">
              {view.map((p) => {
                const totalAssets = totalAssetsOf(p);
                const pnlUsd = totalAssets - p.startUsd;
                const pnlPct = p.startUsd > 0 ? (pnlUsd / p.startUsd) * 100 : 0;
                const pnlColor =
                  pnlUsd > 0
                    ? "text-emerald-400"
                    : pnlUsd < 0
                      ? "text-destructive"
                      : "text-muted-foreground";
                const symbols = p.supplyTokens.map((t) => t.symbol).join(" + ");
                const pendingFees = p.feesSource === "supply_yield" ? 0 : (p.feesUsd ?? 0);
                const totalFees = pendingFees + p.feesClaimedUsd;
                return (
                  <li
                    key={p.id}
                    className={cn(
                      "px-4 py-3 text-xs",
                      isHidden(p) && "opacity-50",
                    )}
                  >
                    <Link
                      to={`/positions/${p.id}`}
                      className="block hover:bg-accent/30 -mx-4 px-4 py-1 -my-1"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex items-center gap-1.5 flex-wrap">
                          <span className="font-medium text-sm truncate">
                            {symbols || p.itemName}
                          </span>
                          <Badge variant="outline" className="text-[9px] uppercase">
                            {p.chain}
                          </Badge>
                          <Badge
                            variant="muted"
                            className={cn("text-[9px]", KIND_BADGE[p.kind])}
                          >
                            {KIND_LABEL[p.kind] ?? p.kind}
                          </Badge>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="tabular-nums font-semibold">
                            {formatUsd(totalAssets, locale)}
                          </div>
                          <div className={"tabular-nums text-[11px] " + pnlColor}>
                            {pnlUsd >= 0 ? "+" : ""}
                            {formatUsd(pnlUsd, locale)} ({pnlPct >= 0 ? "+" : ""}
                            {pnlPct.toFixed(1)}%)
                          </div>
                        </div>
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground truncate">
                        {p.protocol.name} · {p.walletName}
                      </div>
                      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">Cost basis</dt>
                          <dd className="tabular-nums">
                            {formatUsd(p.startUsd, locale)}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">Срок</dt>
                          <dd className="tabular-nums">
                            {p.ageDays != null ? `${p.ageDays} дн` : "—"}
                          </dd>
                        </div>
                        {totalFees > 0 && (
                          <div className="flex justify-between gap-2">
                            <dt className="text-muted-foreground">Fees</dt>
                            <dd className="tabular-nums text-emerald-400">
                              {formatUsd(totalFees, locale)}
                            </dd>
                          </div>
                        )}
                        {p.feeAprLifetime != null && (
                          <div className="flex justify-between gap-2">
                            <dt className="text-muted-foreground">Fee APR</dt>
                            <dd className="tabular-nums text-muted-foreground">
                              {p.feeAprLifetime.toFixed(1)}%
                            </dd>
                          </div>
                        )}
                        {p.currentDebtUsd > 0 && (
                          <div className="flex justify-between gap-2 col-span-2">
                            <dt className="text-muted-foreground">Долг</dt>
                            <dd className="tabular-nums text-destructive">
                              {formatUsd(p.currentDebtUsd, locale)}
                              {p.healthRate != null && (
                                <span className="ml-1 text-[10px]">
                                  · HF {p.healthRate.toFixed(2)}
                                </span>
                              )}
                            </dd>
                          </div>
                        )}
                      </dl>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

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

      {/* Глобальный объяснятор FIFO/LIFO/WAC — открывается из header'а. */}
      <LotMethodologyHelpDialog
        open={methodologyHelpOpen}
        onClose={() => setMethodologyHelpOpen(false)}
      />

      {/* Help-диалог для каждой колонки таблицы. */}
      <ColumnHelpDialog
        open={columnHelpId !== null}
        onClose={() => setColumnHelpId(null)}
        columnId={columnHelpId}
      />

      {/* Единый popup истории покупок underlying. State поднят на уровень
          страницы (`activePurchasePositionId`), это даёт single source of
          truth и устраняет race-conditions когда было по popup'у в каждом
          PositionRow. Каждое нажатие на ⓘ устанавливает активную позицию,
          предыдущий popup автоматически закрывается перед открытием нового. */}
      {activePurchasePosition && (
        <PurchaseHistoryPopup
          key={activePurchasePosition.id}
          open
          onClose={() => setActivePurchasePositionId(null)}
          supplyTokens={activePurchasePosition.supplyTokens.map((t) => ({
            symbol: t.symbol,
            amount: t.amount,
          }))}
          ops={opsByWalletId.get(activePurchasePosition.walletId) ?? []}
          locale={locale}
          startUsdShown={activePurchasePosition.startUsd}
          positionLabel={`${activePurchasePosition.id} · ${activePurchasePosition.protocol.name} · ${activePurchasePosition.itemName}`}
          walletId={activePurchasePosition.walletId}
          protocolId={activePurchasePosition.protocol.id}
          chain={activePurchasePosition.chain}
          histPrices={walletHistPrices.histPrices}
          cexCostBasisByHash={cexCostBasisByHash}
          costBasisOverrideByHash={costBasisOverrideByHash}
        />
      )}
    </div>
  );
}

/* ----------------------------- subcomponents ------------------------------ */

/** Тонкий вертикальный разделитель `·` между значениями. */
const cellPad = "px-2.5 py-1.5";

function PositionRow({
  p,
  v3Map,
  v3Assigned,
  sumCurrentUsd,
  creditOverrideOn,
  onToggleCredit,
  valueOverride,
  feesOverride,
  onSaveCurrentUsd,
  onSaveFeesUsd,
  columnIds,
  compositions,
  onConfigureComposition,
  hidden,
  onToggleHidden,
  onOpenPurchaseHistory,
  v3CostBasisLoading,
}: {
  p: OpenPosition;
  v3Map: V3PositionMap;
  v3Assigned: import("@/lib/v3/positions").V3Position[] | null;
  sumCurrentUsd: number;
  creditOverrideOn: boolean;
  onToggleCredit: () => void;
  /** ID колонок в порядке отображения (после применения prefs). */
  columnIds: string[];
  /** USD-override текущей стоимости (или null если нет). */
  valueOverride: number | null;
  /** USD-override pending fees (или null если нет). */
  feesOverride: number | null;
  /** Сохранить override; null = снять. */
  onSaveCurrentUsd: (v: number | null) => void;
  /** Сохранить override; null = снять. */
  onSaveFeesUsd: (v: number | null) => void;
  compositions: AssetCompositions;
  onConfigureComposition: (symbol: string, scope?: string, label?: string) => void;
  /** Помечена пользователем как скрытая (закрытая). */
  hidden: boolean;
  /** Переключить флаг hidden. */
  onToggleHidden: () => void;
  /** Открыть popup истории покупок underlying для этой позиции. */
  onOpenPurchaseHistory: () => void;
  /**
   * Task #50: useV3LiquidityEvents всё ещё фетчит Etherscan
   * IncreaseLiquidity events. Пока loading=true:
   *  - НЕ показывать страшный ⚠ «Cost basis incomplete» для orphan-кандидатов
   *  - Показывать subtle spinner вместо ⚠ (юзер понимает «грузится», не «error»)
   * После loading=false: если NFT всё ещё orphan → real ⚠.
   */
  v3CostBasisLoading: boolean;
}) {
  const valueOverridden = valueOverride != null;
  const feesOverridden = feesOverride != null;
  const v3OnChain = useMemo<V3Position[]>(() => {
    // Range-блок (Pa/Pb + расчёты выхода) зависит ТОЛЬКО от on-chain данных
    // NFT, не от cost-basis (`p.v3`). Раньше тут стоял `if (!p.v3) return []`,
    // из-за чего позиции без matched lp_add в истории (exotic-пары, staked) не
    // показывали диапазоны, хотя NFT задискаврена. Считаем для всех V3 LP.
    if (!isV3LpProtocol(p.protocol.name)) return [];
    // 1. Pre-computed assignment с parent'а — каждой позиции соответствует
    // ровно ОДНА NFT (если в группе их несколько в одном pair'е).
    if (v3Assigned != null && v3Assigned.length > 0) return v3Assigned;
    // 2. По matched tokenId — устойчиво к symbol-key mismatch. DeBank live
    // symbol (USD₮0, SLVon, …) часто ≠ on-chain token.symbol, и lookup по
    // паре промахивается, хотя NFT задискаврена. tokenId — точный матч.
    if (p.matchedV3TokenId) {
      for (const arr of v3Map.values()) {
        const hit = arr.find((n) => n.tokenId.toString() === p.matchedV3TokenId);
        if (hit) return [hit];
      }
    }
    // 3. Fallback: по канонической паре (symbol-key).
    const deps = findV3Deployments(p.chain, p.protocol.name);
    const out: V3Position[] = [];
    for (const dep of deps) {
      const key = v3PositionKey({
        walletId: p.walletId,
        chain: p.chain,
        deploymentId: dep.id,
        symbols: p.supplyTokens.map((t) => t.symbol),
      });
      const arr = v3Map.get(key);
      if (arr) out.push(...arr);
    }
    return out;
  }, [p, v3Map, v3Assigned]);
  const { locale } = useI18n();
  // PnL позиций — только движение цены (без fee).
  const priceOnlyPnl = p.currentUsd - p.startUsd;
  const priceOnlyPnlPct = safePnlPct(priceOnlyPnl, p.startUsd);
  // Total — fee lifetime (pending + claimed) для отображения в Fee колонке.
  // НО для Aave-style supply_yield positions pending fee УЖЕ в currentUsd
  // (rebase). Для отображения в Fee column используем визуальный сырой
  // pending; для Total Assets — исключаем double-count через `totalAssetsOf`.
  const feesPending = p.feesUsd ?? 0;
  const feesClaimed = p.feesClaimedUsd;
  const feesLifetime = feesPending + feesClaimed;
  const totalAssets = totalAssetsOf(p);
  const totalPnlUsd = totalAssets - p.startUsd;
  const totalPnlPct = safePnlPct(totalPnlUsd, p.startUsd);
  const totalApr =
    p.ageDays != null && p.ageDays > 0 && p.startUsd >= MIN_START_USD_FOR_PCT
      ? (totalPnlUsd / p.startUsd) * (365 / p.ageDays) * 100
      : null;
  const weightPct =
    sumCurrentUsd > 0 ? (p.currentUsd / sumCurrentUsd) * 100 : null;
  const ageLabel =
    p.ageDays == null
      ? "—"
      : p.ageDays === 0
        ? "сегодня"
        : `${p.ageDays} дн.`;

  // UCB C5 Phase F UI (Task #19 + #38): aggregate fallbackUsd по supplyTokens.
  // > 0 → хотя бы один supply-токен имеет cost basis derived от m.usd
  // (silent fallback в supply walker когда LotTracker pустой). Surface'им
  // badge'ом в ID-cell чтобы пользователь видел что startUsd подозрительный.
  const fallbackUsd = p.supplyTokens.reduce(
    (s, t) => s + (t.fallbackUsd ?? 0),
    0,
  );
  const hasFallbackCostBasis = fallbackUsd > 0;

  // Словарь рендереров — ключ ↔ id колонки.
  const renderers: Record<string, () => JSX.Element> = {
    id: () => (
      <td key="id" className={cn(cellPad, "font-mono text-center")}>
        <div className="flex items-center justify-center gap-1.5">
          <Link
            to={`/positions/${p.id}`}
            className="text-brand-cyan hover:underline"
            title="Открыть детальную страницу позиции (UCB E2)"
          >
            {p.id}
          </Link>
          {/* Warning-slot: фиксированная ширина для всех строк, чтобы eye-button
              не «прыгал» при появлении ⚠ badge на orphan-позициях.
              Task #50: при v3CostBasisLoading=true — показываем subtle spinner
              вместо ⚠ для V3 LP orphan-кандидатов (mint history ещё фетчится
              из Etherscan; через 2-3s данные приедут и orphan flag clear'ится).
              Это предотвращает scary первое впечатление для нового user'а. */}
          <span
            className="inline-flex h-4 w-4 shrink-0 items-center justify-center"
            aria-hidden={!p.coverageIncomplete && !hasFallbackCostBasis}
          >
            {p.coverageIncomplete && v3CostBasisLoading ? (
              <span
                className="inline-flex h-4 w-4 cursor-help items-center justify-center text-muted-foreground/60 animate-pulse"
                title={
                  "Загружаем историю mint'а из Etherscan…\n\n" +
                  "Для V3 NFT позиций даты и cost basis подтягиваются из on-chain " +
                  "истории. Это занимает 2-5 секунд при первом заходе. " +
                  "После загрузки даты появятся автоматически."
                }
                aria-label="Loading V3 mint history"
              >
                <Loader2 className="h-3 w-3" />
              </span>
            ) : p.coverageIncomplete ? (
              <span
                className="inline-flex h-4 w-4 cursor-help items-center justify-center text-amber-500"
                title={
                  "⚠ Cost basis incomplete\n\n" +
                  "Mint этой Uniswap V3 NFT не нашёлся в загруженной chain-ops истории. " +
                  "Возможные причины:\n" +
                  "  • Mint произошёл до начала sync (2-5 лет назад)\n" +
                  "  • NFT перенесли transfer'ом из другого адреса\n" +
                  "  • Этот NFT в другом fee-tier'е, чем sibling — наш матчер пока не различает\n\n" +
                  "Стартовая $ = текущая стоимость (fallback). Срок и Fee APR " +
                  "не считаются — нужна реальная дата открытия. Можно задать " +
                  "вручную через детальную страницу позиции."
                }
                aria-label="Cost basis incomplete"
              >
                <AlertTriangle className="h-3 w-3" />
              </span>
            ) : hasFallbackCostBasis ? (
              // UCB C5 Phase F UI (Task #19 + #38): silent m.usd fallback
              // отдельно. LotTracker не имел данных для какого-то supply-токена
              // в момент supply → cost basis derived от текущей spot price
              // (DeBank m.usd) вместо реальной histor-цены. UI badge поменьше
              // и фиолетовый (отличить от orphan'a).
              <span
                className="inline-flex h-4 w-4 cursor-help items-center justify-center text-violet-400"
                title={
                  "⚠ Cost basis derived from current spot price\n\n" +
                  `Для одного из supply-токенов LotTracker не имел данных в момент supply ` +
                  `(вероятно: токен не покрыт нашими classifier'ами для этого протокола, ` +
                  `или missing chain-ops history). ` +
                  `Cost basis для ${(fallbackUsd ?? 0).toFixed(2)}$ из ${p.startUsd.toFixed(2)}$ derived from DeBank spot вместо реальной hist-цены. ` +
                  `\n\nДля long-term позиций это может inflate startUsd ` +
                  `(купил год назад дешевле, current spot выше → wrong PnL).`
                }
                aria-label="Cost basis derived from spot"
              >
                <AlertTriangle className="h-3 w-3" />
              </span>
            ) : null}
          </span>
          <button
            type="button"
            onClick={onToggleHidden}
            className={cn(
              "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/50 transition-colors hover:text-foreground",
              hidden && "text-warning",
            )}
            title={
              hidden
                ? "Показать позицию (отметить как открытую)"
                : "Скрыть позицию (закрыта on-chain)"
            }
          >
            {hidden ? (
              <Eye className="h-3 w-3" />
            ) : (
              <EyeOff className="h-3 w-3" />
            )}
          </button>
        </div>
      </td>
    ),
    openedAt: () => (
      <td
        key="openedAt"
        className={cn(cellPad, "text-center text-muted-foreground tabular-nums whitespace-nowrap")}
      >
        {p.openedAt ? formatDateShort(p.openedAt) : "—"}
      </td>
    ),
    ageDays: () => (
      <td
        key="ageDays"
        className={cn(cellPad, "text-center text-muted-foreground tabular-nums whitespace-nowrap")}
      >
        {ageLabel}
      </td>
    ),
    wallet: () => (
      <td key="wallet" className={cn(cellPad, "text-center")}>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded border border-border bg-secondary px-1.5 py-0.5",
            p.walletChain === "sol" ? "text-[#14F195]" : "text-brand-cyan",
          )}
        >
          <Wallet className="h-3 w-3" />
          {p.walletName}
        </span>
      </td>
    ),
    chain: () => (
      <td key="chain" className={cn(cellPad, "text-center")}>
        <Badge variant="outline" className="uppercase text-[10px]">
          {p.chain}
        </Badge>
      </td>
    ),
    protocol: () => (
      <td key="protocol" className={cn(cellPad, "text-center")}>
        <div className="font-medium leading-tight inline-flex items-center gap-1">
          {p.protocol.name}
          {p.inferred && (
            <span
              className="rounded border border-muted-foreground/40 bg-muted/40 px-1 py-0 text-[9px] uppercase text-muted-foreground"
              title="Реконструировано из истории операций — нет live-источника. Текущую стоимость и fees задайте вручную, кликнув по соответствующей ячейке."
            >
              из истории
            </span>
          )}
        </div>
        {/* itemName переехал в столбец «Тип» — здесь оставляем только
            healthRate badge для lending позиций. */}
        {p.healthRate != null && <HfBadge hf={p.healthRate} />}
      </td>
    ),
    kind: () => (
      // Тип-столбец: plain текст `p.itemName` (Yield / Deposit / Lending /
      // Liquidity Pool — раздел внутри протокола из DeBank `item.name`).
      // Цветные badge'ы убраны для уменьшения визуального шума (user request).
      // Broad-категория (KIND_LABEL) доступна в tooltip + используется
      // для фильтрации в шапке.
      <td key="kind" className={cn(cellPad, "text-center text-xs")}>
        <div className="inline-flex items-center gap-1.5">
          <span
            className="text-foreground"
            title={`Категория: ${KIND_LABEL[p.kind]}`}
          >
            {p.itemName || KIND_LABEL[p.kind]}
          </span>
          {(p.v3 || v3OnChain.length > 0) && (
            <V3InfoButton p={p} onChain={v3OnChain} />
          )}
        </div>
      </td>
    ),
    capital: () => (
      <td key="capital" className={cn(cellPad, "text-center")}>
        <CapitalToggle
          isCredit={creditOverrideOn}
          currentUsd={p.currentUsd}
          onToggle={onToggleCredit}
        />
      </td>
    ),
    tokenId: () => {
      // Для V3 (Uniswap/Aerodrome): NFT tokenId (uint256) из Alchemy
      // enumeration. Для остальных: lpTokenId — receipt-token контракт
      // или pool address.
      // КРИТИЧНО: показываем tokenId даже если p.v3 === null (для unmatched
      // NFT из split, когда buildV3Details вернул null из-за consumed mint).
      // ПРИОРИТЕТ: если override (`applyV3CostBasisOverride`) сматчил
      // OpenPosition к ИМЕННО этой NFT через openHash или amount-proximity,
      // показываем `matchedV3TokenId`. Иначе — все NFT'ы группы (legacy).
      const isV3 = isV3LpProtocol(p.protocol.name);
      const v3Nft = (() => {
        if (!isV3) return null;
        // Per-position match (приоритет).
        if (p.matchedV3TokenId) return [p.matchedV3TokenId];
        const deps = findV3Deployments(p.chain, p.protocol.name);
        for (const dep of deps) {
          const key = v3PositionKey({
            walletId: p.walletId,
            chain: p.chain,
            deploymentId: dep.id,
            symbols: p.supplyTokens.map((t) => t.symbol),
          });
          const arr = v3Map.get(key);
          if (arr && arr.length > 0) {
            return arr.map((n) => n.tokenId.toString());
          }
        }
        return null;
      })();
      const display = v3Nft
        ? v3Nft.length === 1
          ? `#${v3Nft[0]}`
          : `${v3Nft.length} NFTs`
        : p.lpTokenId
          ? `${p.lpTokenId.slice(0, 8)}…${p.lpTokenId.slice(-4)}`
          : "—";
      const title = v3Nft
        ? `V3 NFT tokenId(s):\n${v3Nft.map((id) => `  #${id}`).join("\n")}`
        : p.lpTokenId
          ? `LP receipt / pool: ${p.lpTokenId}`
          : "Нет lpTokenId";
      return (
        <td key="tokenId" className={cn(cellPad, "text-center")}>
          <span
            className="font-mono text-[10px] text-muted-foreground tabular-nums"
            title={title}
          >
            {display}
          </span>
        </td>
      );
    },
    // «В чём открыли (токен)» / «Начальная сумма инвестиций в токене» —
    // источник = `p.openedInTokens`, который заполняется в builder'е из
    // chain_op'ов (OUT-side движения deposit-tx с правилами выбора
    // receipt-vs-underlying). Это даёт корректное имя/amount для
    // aggregated-receipt позиций (GMX GM, Morpho-c-GLV-collateral),
    // где `supplyTokens` показывает синтетическую декомпозицию underlying
    // (WETH+USDC) вместо реального deposit-token (GLV/GM).
    //
    // Fallback на supplyTokens, если по какой-то причине openedInTokens
    // пустой (старые позиции в кэше до обновления, нишевые протоколы).
    openedInToken: () => {
      const tokens =
        p.openedInTokens && p.openedInTokens.length > 0
          ? p.openedInTokens
          : p.supplyTokens.map((t) => ({
              symbol: t.symbol,
              amount: t.startAmount,
              ...(t.tokenId && { tokenId: t.tokenId }),
            }));
      return (
        <td key="openedInToken" className={cn(cellPad, "text-center whitespace-nowrap")}>
          <div className="flex flex-col items-center gap-0">
            {tokens.map((t) => (
              <span
                key={t.symbol}
                className="text-muted-foreground leading-tight"
                title={t.tokenId ? `tokenId: ${t.tokenId}` : t.symbol}
              >
                {t.symbol}
              </span>
            ))}
          </div>
        </td>
      );
    },
    openedInAmount: () => {
      const tokens =
        p.openedInTokens && p.openedInTokens.length > 0
          ? p.openedInTokens
          : p.supplyTokens.map((t) => ({
              symbol: t.symbol,
              amount: t.startAmount,
            }));
      return (
        <td
          key="openedInAmount"
          className={cn(cellPad, "text-center tabular-nums whitespace-nowrap")}
        >
          <div className="flex flex-col gap-0 items-center">
            {tokens.map((t) => (
              <span key={t.symbol} className="font-mono leading-tight">
                {formatNumber(t.amount, locale, 6)}
              </span>
            ))}
          </div>
        </td>
      );
    },
    supplyTokens: () => {
      const positionScope = positionOverrideKey({
        walletId: p.walletId,
        chain: p.chain,
        protocolId: p.protocol.id,
        symbols: p.supplyTokens.map((t) => t.symbol),
        ...(p.instanceId && { instanceId: p.instanceId }),
      });
      return (
      <td key="supplyTokens" className={cn(cellPad, "text-center")}>
        <div className="flex flex-col items-center gap-0">
          {p.supplyTokens.map((t) => {
            const has =
              compositions[`${positionScope}::${normalizeCompositionKey(t.symbol)}`] != null;
            return (
              <div key={t.symbol} className="flex items-center justify-center gap-1 leading-tight">
                <span className="font-mono tabular-nums">
                  {formatNumber(t.amount, locale, 6)}
                </span>
                <span className="text-muted-foreground">{t.symbol}</span>
                <button
                  type="button"
                  onClick={() =>
                    onConfigureComposition(t.symbol, positionScope, p.id)
                  }
                  className={cn(
                    "inline-flex h-3.5 w-3.5 items-center justify-center rounded transition-colors",
                    has
                      ? "text-brand-cyan hover:text-brand-cyan/80"
                      : "text-muted-foreground/50 hover:text-foreground",
                  )}
                  title={has ? `Изменить состав ${t.symbol} (${p.id})` : `Указать состав ${t.symbol} для ${p.id}`}
                >
                  <Settings2 className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      </td>
      );
    },
    startUsd: () => {
      // UCB D7: показываем net startUsd для leveraged lending позиций.
      // Расхождение > 1% означает значимый borrow leg — выделяем "net"
      // отдельной строкой ниже gross, чтобы user видел реальные затраты.
      const hasMeaningfulBorrow =
        p.startUsd > 0 &&
        p.netStartUsd >= 0 &&
        p.startUsd - p.netStartUsd > Math.max(1, p.startUsd * 0.01);
      const leverage =
        hasMeaningfulBorrow && p.netStartUsd > 0
          ? p.startUsd / p.netStartUsd
          : null;
      return (
        <td key="startUsd" className={cn(cellPad, "text-center tabular-nums")}>
          <div className="flex flex-col items-center gap-0.5">
            <span className="inline-flex items-center gap-1">
              {formatUsd(p.startUsd, locale)}
              {p.kind === "lending" && p.supplyTokens.length > 0 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenPurchaseHistory();
                  }}
                  className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-brand-cyan/50 bg-brand-cyan/15 text-[9px] font-bold text-brand-cyan hover:bg-brand-cyan/30 hover:border-brand-cyan transition-colors"
                  title="История покупок underlying — как формируется Стартовая $"
                >
                  ?
                </button>
              )}
            </span>
            {hasMeaningfulBorrow && (
              <span
                className="text-[10px] text-muted-foreground"
                title={`Net = collateral cost − borrow proceeds. Leverage ≈ ${leverage?.toFixed(2)}×.`}
              >
                net {formatUsd(p.netStartUsd, locale)}
                {leverage != null && (
                  <span className="ml-1 text-brand-cyan">
                    · {leverage.toFixed(2)}×
                  </span>
                )}
              </span>
            )}
          </div>
        </td>
      );
    },
    currentUsd: () => (
      <td key="currentUsd" className={cn(cellPad, "text-center tabular-nums")}>
        <EditableUsdCell
          value={p.currentUsd}
          isOverridden={valueOverridden}
          canEdit={p.inferred === true || valueOverridden}
          onSave={onSaveCurrentUsd}
          label="Текущая стоимость, $"
        />
      </td>
    ),
    pnl: () => (
      <td key="pnl" className={cn(cellPad, "text-center tabular-nums")}>
        <PnlCell usd={priceOnlyPnl} pct={priceOnlyPnlPct} />
      </td>
    ),
    fee: () => (
      <td key="fee" className={cn(cellPad, "text-center tabular-nums")}>
        <EditableFeesCell
          p={p}
          feesLifetime={feesLifetime}
          isOverridden={feesOverridden}
          canEdit={p.inferred === true || feesOverridden}
          onSave={onSaveFeesUsd}
        />
      </td>
    ),
    feeApr: () => (
      <td key="feeApr" className={cn(cellPad, "text-center tabular-nums")}>
        {p.feeAprLifetime != null && p.feeAprLifetime > 0 ? (
          <FeeAprCell p={p} />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
    ),
    totalAssets: () => (
      <td key="totalAssets" className={cn(cellPad, "text-center tabular-nums")}>
        {formatUsd(totalAssets, locale)}
      </td>
    ),
    totalPnl: () => (
      <td key="totalPnl" className={cn(cellPad, "text-center tabular-nums")}>
        <PnlCell usd={totalPnlUsd} pct={totalPnlPct} />
      </td>
    ),
    totalApr: () => (
      <td key="totalApr" className={cn(cellPad, "text-center tabular-nums")}>
        {totalApr != null ? (
          <span
            className={cn(
              "font-medium",
              totalApr >= 0 ? "text-success" : "text-destructive",
            )}
          >
            {totalApr >= 0 ? "+" : ""}
            {totalApr.toFixed(2)}%
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
    ),
    weight: () => (
      <td key="weight" className={cn(cellPad, "text-center tabular-nums")}>
        <span className="text-muted-foreground">
          {weightPct != null ? `${weightPct.toFixed(1)}%` : "—"}
        </span>
      </td>
    ),
  };

  return (
    <tr className={cn("hover:bg-accent/40 text-xs", hidden && "opacity-50")}>
      {columnIds.map((id) => renderers[id]?.() ?? null)}
    </tr>
  );
}

/**
 * Inline-editable USD-ячейка. По умолчанию — обычный текст; при клике на
 * иконку ✎ превращается во input. Enter / blur — сохранить, Escape — отмена,
 * пустая строка при сохранении — снять override.
 *
 * `canEdit` управляет видимостью ✎: показываем только когда позиция
 * inferred (нужен ручной ввод) или уже есть override (нужно изменить/убрать).
 * Для live-позиций без override — ✎ скрыта.
 */
function EditableUsdCell({
  value,
  isOverridden,
  canEdit,
  onSave,
  label,
}: {
  value: number;
  isOverridden: boolean;
  canEdit: boolean;
  onSave: (v: number | null) => void;
  label: string;
}) {
  const { locale } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const startEdit = () => {
    setDraft(value.toFixed(2));
    setEditing(true);
  };
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      onSave(null);
    } else {
      const n = Number(trimmed.replace(",", "."));
      if (Number.isFinite(n) && n >= 0) onSave(n);
    }
    setEditing(false);
  };
  const cancel = () => setEditing(false);

  if (editing) {
    return (
      <input
        type="text"
        inputMode="decimal"
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") cancel();
        }}
        title={label}
        className="w-24 rounded border border-warning bg-background px-1 py-0.5 text-right tabular-nums focus:outline-none focus:ring-1 focus:ring-warning"
      />
    );
  }

  return (
    <div className="inline-flex items-center gap-1">
      <span className={cn(isOverridden && "font-medium text-warning")}>
        {formatUsd(value, locale)}
      </span>
      {canEdit && (
        <button
          type="button"
          onClick={startEdit}
          aria-label={isOverridden ? "Изменить ручное значение" : label}
          title={isOverridden ? "Изменить ручное значение" : label}
          className="rounded p-0.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
        >
          <Pencil className="h-3 w-3" />
        </button>
      )}
      {isOverridden && (
        <button
          type="button"
          onClick={() => onSave(null)}
          aria-label="Убрать ручное значение"
          title="Убрать ручное значение"
          className="rounded p-0.5 text-muted-foreground/70 hover:bg-destructive/10 hover:text-destructive"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

/**
 * Аналог EditableUsdCell для Fee — внутри отрисовываем существующий
 * `FeesUsdCell` (с popover'ом "pending + claimed"), а вокруг —
 * иконка ✎/× и плашка «руч.».
 */
function EditableFeesCell({
  p,
  feesLifetime,
  isOverridden,
  canEdit,
  onSave,
}: {
  p: OpenPosition;
  feesLifetime: number;
  isOverridden: boolean;
  canEdit: boolean;
  onSave: (v: number | null) => void;
}) {
  const { locale } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const startEdit = () => {
    setDraft((p.feesUsd ?? 0).toFixed(2));
    setEditing(true);
  };
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      onSave(null);
    } else {
      const n = Number(trimmed.replace(",", "."));
      if (Number.isFinite(n) && n >= 0) onSave(n);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        type="text"
        inputMode="decimal"
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") setEditing(false);
        }}
        title="Pending fees (override)"
        className="w-20 rounded border border-warning bg-background px-1 py-0.5 text-right tabular-nums focus:outline-none focus:ring-1 focus:ring-warning"
      />
    );
  }

  return (
    <div className="inline-flex items-center gap-1">
      {feesLifetime > 0 ? (
        <FeesUsdCell p={p} />
      ) : (
        <span className={cn("text-muted-foreground", isOverridden && "text-warning")}>
          {isOverridden ? formatUsd(p.feesUsd ?? 0, locale) : "—"}
        </span>
      )}
      {canEdit && (
        <button
          type="button"
          onClick={startEdit}
          aria-label={isOverridden ? "Изменить ручные fees" : "Задать fees вручную"}
          title={isOverridden ? "Изменить ручные fees" : "Задать pending fees вручную"}
          className="rounded p-0.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
        >
          <Pencil className="h-3 w-3" />
        </button>
      )}
      {isOverridden && (
        <button
          type="button"
          onClick={() => onSave(null)}
          aria-label="Убрать ручные fees"
          title="Убрать ручные fees"
          className="rounded p-0.5 text-muted-foreground/70 hover:bg-destructive/10 hover:text-destructive"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

/* =========================== Сводная аналитика ============================ */

interface AnalyticsData {
  positionCount: number;
  investedUsd: number;
  currentUsd: number;
  /** PnL без дивидендов = current − invested (только цена). */
  priceOnlyPnlUsd: number;
  priceOnlyPnlPct: number;
  /** Pending fees (внутри позиций), Claimed (на кошельке), lifetime = pending + claimed. */
  feesPendingUsd: number;
  feesClaimedUsd: number;
  feesLifetimeUsd: number;
  /** Pending по токенам — для popover. */
  feesPendingByToken: Map<string, { amount: number; usd: number }>;
  /** Полная стоимость = current + claimed (как просил пользователь). */
  totalAssetsUsd: number;
  /** Total PnL = totalAssets − invested. */
  totalPnlUsd: number;
  totalPnlPct: number;
  /** Средневзвешенный Fee APR (по currentUsd). */
  avgFeeAprPct: number | null;
  /** Средневзвешенный Total APR (по currentUsd). */
  avgTotalAprPct: number | null;
}

function computeAnalytics(positions: OpenPosition[]): AnalyticsData {
  const investedUsd = positions.reduce((s, p) => s + p.startUsd, 0);
  const currentUsd = positions.reduce((s, p) => s + p.currentUsd, 0);

  // P0b: Pending fees. Для supply_yield (Aave/Compound/Fluid aTokens) `p.feesUsd`
  // — derived view (`current − Σdeposited`), который УЖЕ включён в `currentUsd`
  // (rebase-style). Если суммировать его в pending — получим double-count
  // относительно `totalAssetsUsd` (которая правильно skip'ает supply_yield
  // через totalAssetsOf). Поэтому реальный pending — только v3_rewards / прочие.
  const feesPendingUsd = positions.reduce(
    (s, p) => s + (p.feesSource === "supply_yield" ? 0 : (p.feesUsd ?? 0)),
    0,
  );
  const feesClaimedUsd = positions.reduce((s, p) => s + p.feesClaimedUsd, 0);
  const feesLifetimeUsd = feesPendingUsd + feesClaimedUsd;

  // Pending по токенам — суммируем p.feesByToken для тех же позиций
  // (исключая supply_yield во избежание double-count, см. выше).
  const feesPendingByToken = new Map<string, { amount: number; usd: number }>();
  for (const p of positions) {
    if (p.feesSource === "supply_yield") continue;
    for (const t of p.feesByToken) {
      const cur = feesPendingByToken.get(t.symbol) ?? { amount: 0, usd: 0 };
      cur.amount += t.amount;
      cur.usd += t.usd;
      feesPendingByToken.set(t.symbol, cur);
    }
  }

  // «Итого активы» — sum of `totalAssetsOf(p)` (учитывает supply_yield
  // double-count protection: для Aave/Compound aTokens currentUsd УЖЕ
  // включает накопленный yield, не складываем с feesUsd).
  const totalAssetsUsd = positions.reduce((s, p) => s + totalAssetsOf(p), 0);

  // P0c: Price PnL = изменение цены БЕЗ дивидендов. Для supply_yield (rebase)
  // `currentUsd` уже содержит accrued yield, поэтому считаем «как если бы
  // yield не было» = currentUsd − feesUsd_derived. Иначе «PnL без fee»
  // ложно включал бы yield в price-движение.
  const priceOnlyPnlUsd = positions.reduce((s, p) => {
    const yieldInCurrent = p.feesSource === "supply_yield" ? (p.feesUsd ?? 0) : 0;
    return s + (p.currentUsd - yieldInCurrent - p.startUsd);
  }, 0);
  const priceOnlyPnlPct = investedUsd > 0 ? (priceOnlyPnlUsd / investedUsd) * 100 : 0;
  const totalPnlUsd = totalAssetsUsd - investedUsd;
  const totalPnlPct = investedUsd > 0 ? (totalPnlUsd / investedUsd) * 100 : 0;

  // Средневзвешенно по currentUsd. Per-row Total PnL = totalAssets − start.
  // P0a: feeAprWeightDenom отдельный — иначе позиции без feeAprLifetime
  // (null) разбавляли знаменатель, занижая средний Fee APR в 2-3 раза.
  let totalAprWSum = 0;
  let totalAprWeightDenom = 0;
  let feeAprWSum = 0;
  let feeAprWeightDenom = 0;
  for (const p of positions) {
    if (
      !p.ageDays ||
      p.ageDays <= 0 ||
      p.currentUsd <= 0 ||
      p.startUsd < MIN_START_USD_FOR_PCT
    )
      continue;
    const totalPnlI = totalAssetsOf(p) - p.startUsd;
    const totalAprI = (totalPnlI / p.startUsd) * (365 / p.ageDays) * 100;
    totalAprWSum += totalAprI * p.currentUsd;
    totalAprWeightDenom += p.currentUsd;
    if (p.feeAprLifetime != null) {
      feeAprWSum += p.feeAprLifetime * p.currentUsd;
      feeAprWeightDenom += p.currentUsd;
    }
  }
  const avgTotalAprPct =
    totalAprWeightDenom > 0 ? totalAprWSum / totalAprWeightDenom : null;
  const avgFeeAprPct =
    feeAprWeightDenom > 0 ? feeAprWSum / feeAprWeightDenom : null;

  return {
    positionCount: positions.length,
    investedUsd,
    currentUsd,
    priceOnlyPnlUsd,
    priceOnlyPnlPct,
    feesPendingUsd,
    feesClaimedUsd,
    feesLifetimeUsd,
    feesPendingByToken,
    totalAssetsUsd,
    totalPnlUsd,
    totalPnlPct,
    avgFeeAprPct,
    avgTotalAprPct,
  };
}

/**
 * Компактный stat-strip: 9 KPI в горизонтальном ряду с тонкими разделителями.
 * Адаптивно: на узких экранах — auto-flow grid (2 col → 3 → 5 → 9).
 *
 * `accentGradient` — главная сводка (cyan-glow strip сверху).
 * `accentDanger` — кредитные позиции (красный акцент).
 */
function AnalyticsBlock({
  title,
  data,
  accentGradient,
  accentDanger,
}: {
  title: string;
  data: AnalyticsData;
  accentGradient?: boolean;
  accentDanger?: boolean;
}) {
  const { locale } = useI18n();
  const fmt = (v: number) => formatUsd(v, locale);
  const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  const fmtUsdSigned = (v: number) => `${v >= 0 ? "+" : ""}${fmt(v)}`;

  const ringClass = accentDanger
    ? "ring-1 ring-destructive/30"
    : accentGradient
      ? "ring-1 ring-brand-cyan/30"
      : "";

  // Готовим описание метрик в виде «короткое + детально».
  const KPI_DESCRIPTIONS = {
    count: {
      title: "Кол-во позиций",
      body: "Количество открытых DeFi-позиций после применения фильтров. Каждая саб-позиция (например, Fluid с двумя залогами или GMX с двумя пулами) — отдельная строка.",
    },
    invested: {
      title: "Инвестировано",
      body: "Сумма всех вкладов в текущие позиции. Считается как Σ (amount токена × его средневзвешенная цена покупки за всю историю кошелька). То есть «что я заплатил» в долларах.",
    },
    current: {
      title: "Текущая стоимость активов",
      body: "Σ live-стоимости всех позиций прямо сейчас. Pending дивиденды (внутри позиции) и собранные дивиденды (на кошельке) НЕ включаются — они выделены отдельно.",
    },
    pnl: {
      title: "Price PnL",
      body: "Прибыль/убыток ТОЛЬКО от движения цены, без дивидендов. Для обычных позиций = Текущая стоимость − Инвестировано. Для rebase-токенов (Aave/Compound/Fluid aTokens, где currentUsd уже включает yield) — yield предварительно вычитается, чтобы метрика не путала price-движение с дивидендами.",
    },
    totalAssets: {
      title: "Общая сумма активов",
      body: "Полная стоимость с учётом собранных дивидендов. = Текущая стоимость позиций + Собранные дивиденды (claimed). Это ваш реальный «капитал в работе» прямо сейчас.",
    },
    totalPnl: {
      title: "Total PnL",
      body: "Полный финансовый результат С УЧЁТОМ дивидендов. = Общая сумма активов − Инвестировано. Это сколько вы реально заработали (или потеряли).",
    },
    feeApr: {
      title: "avg Fee APR",
      body: "Средневзвешенная годовая доходность ТОЛЬКО от дивидендов (LP-комиссии, supply-yield лендинга), без учёта движения цены токенов. Веса — текущие стоимости позиций. Формула per-позиция: feesLifetime / startUsd × 365 / ageDays.",
    },
    totalApr: {
      title: "avg Total APR",
      body: "Средневзвешенная годовая ПОЛНАЯ доходность (дивиденды + изменение цены токенов). Веса — текущие стоимости позиций. Формула per-позиция: totalPnL / startUsd × 365 / ageDays.",
    },
  };

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border border-border bg-card shadow-sm",
        ringClass,
      )}
    >
      {/* Brand-glow strip сверху */}
      <span
        className={cn(
          "pointer-events-none absolute inset-x-6 -top-px h-px opacity-70",
          accentDanger ? "bg-destructive" : "bg-brand-gradient",
        )}
      />
      {/* Заголовок */}
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2">
        <span
          className={cn(
            "inline-block h-1.5 w-1.5 rounded-full",
            accentDanger ? "bg-destructive" : "bg-brand-cyan",
          )}
        />
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-foreground">
          {title}
        </h4>
      </div>
      {/* KPI grid: 5 в ряд на большом экране, 2-3 на узком. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-5">
        <KpiPill
          info={KPI_DESCRIPTIONS.count}
          value={
            <AnimatedNumber
              value={data.positionCount}
              format={(v) => String(Math.round(v))}
            />
          }
        />
        <KpiPill
          info={KPI_DESCRIPTIONS.invested}
          value={
            data.investedUsd > 0 ? (
              <AnimatedNumber value={data.investedUsd} format={fmt} />
            ) : (
              "—"
            )
          }
        />
        <KpiPill
          info={KPI_DESCRIPTIONS.current}
          value={
            data.currentUsd > 0 ? (
              <AnimatedNumber value={data.currentUsd} format={fmt} />
            ) : (
              "—"
            )
          }
        />
        <KpiPill
          info={KPI_DESCRIPTIONS.totalAssets}
          highlight
          value={
            data.totalAssetsUsd > 0 ? (
              <AnimatedNumber value={data.totalAssetsUsd} format={fmt} />
            ) : (
              "—"
            )
          }
        />
        <KpiPill
          info={KPI_DESCRIPTIONS.totalPnl}
          highlight
          accent={
            data.investedUsd > 0
              ? data.totalPnlUsd >= 0
                ? "success"
                : "destructive"
              : undefined
          }
          value={
            data.investedUsd > 0 ? (
              <span className="inline-flex items-baseline gap-1.5">
                <AnimatedNumber value={data.totalPnlUsd} format={fmtUsdSigned} />
                <span className="text-[11px] opacity-80">
                  {fmtPct(data.totalPnlPct)}
                </span>
              </span>
            ) : (
              "—"
            )
          }
        />
        <KpiPill
          info={{
            title: "PnL (без fee)",
            body: KPI_DESCRIPTIONS.pnl.body,
          }}
          accent={
            data.investedUsd > 0
              ? data.priceOnlyPnlUsd >= 0
                ? "success"
                : "destructive"
              : undefined
          }
          value={
            data.investedUsd > 0 ? (
              <span className="inline-flex items-baseline gap-1.5">
                <AnimatedNumber value={data.priceOnlyPnlUsd} format={fmtUsdSigned} />
                <span className="text-[11px] opacity-80">
                  {fmtPct(data.priceOnlyPnlPct)}
                </span>
              </span>
            ) : (
              "—"
            )
          }
        />
        <FeePillCell data={data} />
        <KpiPill
          info={KPI_DESCRIPTIONS.feeApr}
          accent={
            data.avgFeeAprPct != null && data.avgFeeAprPct > 0
              ? "success"
              : undefined
          }
          value={
            data.avgFeeAprPct != null ? (
              <AnimatedNumber value={data.avgFeeAprPct} format={(v) => fmtPct(v)} />
            ) : (
              "—"
            )
          }
        />
        <KpiPill
          info={KPI_DESCRIPTIONS.totalApr}
          highlight
          accent={
            data.avgTotalAprPct != null
              ? data.avgTotalAprPct >= 0
                ? "success"
                : "destructive"
              : undefined
          }
          value={
            data.avgTotalAprPct != null ? (
              <AnimatedNumber value={data.avgTotalAprPct} format={(v) => fmtPct(v)} />
            ) : (
              "—"
            )
          }
        />
      </div>
    </div>
  );
}

/**
 * KPI-пилюля для analytics-strip.
 * - `info` — заголовок и развёрнутое описание метрики (Tooltip on hover).
 * - `value` — ReactNode (часто AnimatedNumber).
 * - `highlight` — выделить как ключевой показатель (cyan-glow background).
 */
function KpiPill({
  info,
  value,
  accent,
  highlight,
}: {
  info: { title: string; body: string };
  value: React.ReactNode;
  accent?: "success" | "destructive";
  highlight?: boolean;
}) {
  return (
    <div
      className={cn(
        "group relative border-b border-r border-border/40 px-4 py-3 transition-colors last:border-r-0 hover:bg-secondary/40",
        highlight && "bg-gradient-to-br from-brand-cyan/[0.04] to-transparent",
      )}
    >
      <div className="mb-1 flex items-center gap-1.5">
        <span className="truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {info.title}
        </span>
        <InfoTip title={info.title} body={info.body} />
      </div>
      <div
        className={cn(
          "truncate tabular-nums font-semibold tracking-tight",
          highlight ? "text-base" : "text-sm",
          accent === "success" && "text-success",
          accent === "destructive" && "text-destructive",
        )}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * Иконка-подсказка с кастомным Tooltip — мгновенный показ, брендовый стиль,
 * содержательный текст «как метрика считается».
 */
function InfoTip({ title, body }: { title: string; body: string }) {
  return (
    <Tooltip
      maxWidth={300}
      content={
        <div className="space-y-1">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-brand-cyan">
            {title}
          </div>
          <div className="text-xs leading-relaxed text-foreground/90">
            {body}
          </div>
        </div>
      }
    >
      <span className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-brand-cyan/15 hover:text-brand-cyan">
        <Info className="h-3 w-3" />
      </span>
    </Tooltip>
  );
}

/**
 * Fee-ячейка в horizontal stat-strip с popover'ом: общий lifetime +
 * breakdown по pending/claimed + список pending fee по токенам.
 */
/* ========================== Структура активов ============================ */

/** Палитра брендового стиля: cyan→blue→deep + аккуратные акценты. */
const PALETTE = [
  "#22d3ee", // brand-cyan
  "#60a5fa", // blue-400
  "#3b82f6", // blue-500
  "#818cf8", // indigo-400
  "#a78bfa", // violet-400
  "#fbbf24", // amber-400
  "#fb923c", // orange-400
  "#34d399", // emerald-400
  "#f472b6", // pink-400
  "#94a3b8", // slate-400
];

interface BreakdownEntry {
  key: string;
  label: string;
  usd: number;
  pct: number;
  count: number;
  color: string;
  /** Под-разбивка для агрегатов (Стейблкоины → USDC/USDT/…, ETH → ETH/WETH). */
  subItems?: { label: string; usd: number; pct: number }[];
}

/** Канонизирует токен — обёртки сводим к базовому активу. */
function canonicalAsset(symbol: string): string {
  const s = symbol.toUpperCase();
  if (isStableSymbol(s)) return "STABLES";
  if (s === "ETH" || s === "WETH") return "ETH";
  if (s === "BTC" || s === "WBTC" || s === "TBTC" || s === "CBBTC") return "BTC";
  if (s === "SOL" || s === "WSOL") return "SOL";
  return s;
}

const CANONICAL_LABEL: Record<string, string> = {
  STABLES: "Стейблкоины",
  ETH: "ETH",
  BTC: "BTC",
  SOL: "SOL",
};

function buildTokenBreakdown(
  positions: OpenPosition[],
  total: number,
  compositions: AssetCompositions = {},
): BreakdownEntry[] {
  // Делим totalAssets позиции (currentUsd + lifetime fees) пропорционально
  // между supply-токенами по их текущему весу. Если для wrapper-символа
  // задан состав — раскладываем по underlying.
  const rawBySym = new Map<string, number>();
  for (const p of positions) {
    const supplySum = p.supplyTokens.reduce((s, t) => s + t.currentUsd, 0);
    if (supplySum <= 0) continue;
    const ta = totalAssetsOf(p);
    const scope = positionOverrideKey({
      walletId: p.walletId,
      chain: p.chain,
      protocolId: p.protocol.id,
      symbols: p.supplyTokens.map((t) => t.symbol),
      ...(p.instanceId && { instanceId: p.instanceId }),
    });
    for (const t of p.supplyTokens) {
      const share = (t.currentUsd / supplySum) * ta;
      for (const e of expandByComposition(t.symbol, share, compositions, scope)) {
        const sym = e.symbol.toUpperCase();
        rawBySym.set(sym, (rawBySym.get(sym) ?? 0) + e.usd);
      }
    }
  }

  // Группируем по canonical-asset, накапливая subItems для разбивки.
  type Group = { usd: number; subs: Map<string, number>; isAggregate: boolean };
  const groups = new Map<string, Group>();
  for (const [sym, usd] of rawBySym) {
    const canon = canonicalAsset(sym);
    const g = groups.get(canon) ?? {
      usd: 0,
      subs: new Map<string, number>(),
      isAggregate: false,
    };
    g.usd += usd;
    g.subs.set(sym, (g.subs.get(sym) ?? 0) + usd);
    groups.set(canon, g);
  }
  // Aggregates считаем те, у которых subs.size > 1 ИЛИ canon ≠ исходному
  // символу (например, единственный USDC всё равно показываем как «Стейблкоины»
  // если хотим консистентность; но я сделаю помягче — aggregate только
  // когда реально >1 sub).
  for (const [canon, g] of groups) {
    g.isAggregate = g.subs.size > 1;
    if (canon === "STABLES" && g.subs.size >= 1) g.isAggregate = true; // всегда показываем как агрегат
  }

  const sorted = [...groups.entries()]
    .map(([canon, v]) => ({ canon, ...v }))
    .sort((a, b) => b.usd - a.usd);

  const head = sorted.slice(0, 9);
  const tail = sorted.slice(9);
  const tailUsd = tail.reduce((s, t) => s + t.usd, 0);

  const all: BreakdownEntry[] = head.map((g, i) => {
    const label = CANONICAL_LABEL[g.canon] ?? g.canon;
    // Sort sub-items by usd desc.
    const subItemsArr = [...g.subs.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([s, u]) => ({
        label: s,
        usd: u,
        pct: total > 0 ? (u / total) * 100 : 0,
      }));
    return {
      key: g.canon,
      label,
      usd: g.usd,
      pct: total > 0 ? (g.usd / total) * 100 : 0,
      count: g.subs.size,
      color: PALETTE[i % PALETTE.length]!,
      ...(g.isAggregate && { subItems: subItemsArr }),
    };
  });
  if (tailUsd > 0) {
    all.push({
      key: "OTHER",
      label: "Прочее",
      usd: tailUsd,
      pct: total > 0 ? (tailUsd / total) * 100 : 0,
      count: tail.length,
      color: PALETTE[9]!,
    });
  }
  return all;
}

/**
 * Разбивка по Total PnL — каждая позиция отдельный сегмент.
 * - Размер = |totalPnl| / Σ|totalPnl| × 100 (чтобы суммарно 100%)
 * - Цвет = зелёный для прибыли, красный для убытка
 * - Хорошо отвечает на вопрос «какая позиция лучше работает»
 *
 * Возвращаем `total` отдельным значением — это NET (со знаком), для центра
 * donut'а; pct в entries — от Σ|pnl|.
 */
function buildPnlBreakdown(positions: OpenPosition[]): {
  entries: BreakdownEntry[];
  netTotal: number;
} {
  const items = positions
    .map((p) => {
      const totalPnl = totalAssetsOf(p) - p.startUsd;
      return { p, totalPnl };
    })
    .filter((x) => Math.abs(x.totalPnl) >= 0.01);

  const absSum = items.reduce((s, i) => s + Math.abs(i.totalPnl), 0);
  const netTotal = items.reduce((s, i) => s + i.totalPnl, 0);

  // Сортировка: сначала самые прибыльные, потом самые убыточные.
  items.sort((a, b) => b.totalPnl - a.totalPnl);

  const head = items.slice(0, 9);
  const tail = items.slice(9);
  const tailUsd = tail.reduce((s, i) => s + Math.abs(i.totalPnl), 0);

  const entries: BreakdownEntry[] = head.map((i) => ({
    key: i.p.id,
    label: `${i.p.protocol.name} · ${i.p.id}`,
    usd: i.totalPnl, // signed — используется для отображения
    pct: absSum > 0 ? (Math.abs(i.totalPnl) / absSum) * 100 : 0,
    count: 1,
    // Зелёный для прибыли, красный для убытка.
    color: i.totalPnl >= 0 ? "#22c55e" : "#ef4444",
  }));
  if (tailUsd > 0) {
    const tailNet = tail.reduce((s, i) => s + i.totalPnl, 0);
    entries.push({
      key: "OTHER",
      label: `Прочие · ${tail.length} поз.`,
      usd: tailNet,
      pct: absSum > 0 ? (tailUsd / absSum) * 100 : 0,
      count: tail.length,
      color: tailNet >= 0 ? "#22c55e" : "#ef4444",
    });
  }
  return { entries, netTotal };
}

/**
 * Распределение totalAssets по кошелькам, sub-items = протоколы внутри
 * кошелька (по убыванию). Hover на сегмент → разворачиваются протоколы
 * с их $ и % долей от всего портфеля.
 */
function buildWalletBreakdown(
  positions: OpenPosition[],
  total: number,
): BreakdownEntry[] {
  const m = new Map<
    string,
    {
      name: string;
      usd: number;
      count: number;
      protos: Map<string, number>;
    }
  >();
  for (const p of positions) {
    const cur = m.get(p.walletId) ?? {
      name: p.walletName,
      usd: 0,
      count: 0,
      protos: new Map<string, number>(),
    };
    const ta = totalAssetsOf(p);
    cur.usd += ta;
    cur.count += 1;
    cur.protos.set(
      p.protocol.name,
      (cur.protos.get(p.protocol.name) ?? 0) + ta,
    );
    m.set(p.walletId, cur);
  }
  return [...m.entries()]
    .map(([walletId, v], i) => {
      const subItems =
        v.protos.size > 0
          ? [...v.protos.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([protoName, usd]) => ({
                label: protoName,
                usd,
                pct: total > 0 ? (usd / total) * 100 : 0,
              }))
          : undefined;
      return {
        key: walletId,
        label: v.name,
        usd: v.usd,
        pct: total > 0 ? (v.usd / total) * 100 : 0,
        count: v.count,
        color: PALETTE[i % PALETTE.length]!,
        ...(subItems && { subItems }),
      };
    })
    .sort((a, b) => b.usd - a.usd);
}

function buildProtocolBreakdown(
  positions: OpenPosition[],
  total: number,
): BreakdownEntry[] {
  // Группируем + собираем sub-разбивку по позициям внутри каждого протокола.
  const m = new Map<
    string,
    {
      usd: number;
      count: number;
      name: string;
      positions: { posId: string; itemName: string; usd: number }[];
    }
  >();
  for (const p of positions) {
    const id = p.protocol.id;
    const cur = m.get(id) ?? {
      usd: 0,
      count: 0,
      name: p.protocol.name,
      positions: [],
    };
    const ta = totalAssetsOf(p);
    cur.usd += ta;
    cur.count += 1;
    cur.positions.push({
      posId: p.id,
      itemName: p.itemName,
      usd: ta,
    });
    m.set(id, cur);
  }
  const sorted = [...m.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.usd - a.usd);
  const head = sorted.slice(0, 9);
  const tail = sorted.slice(9);
  const tailUsd = tail.reduce((s, t) => s + t.usd, 0);
  const tailCount = tail.reduce((s, t) => s + t.count, 0);
  const all: BreakdownEntry[] = head.map((t, i) => {
    // subItems показываем только если внутри протокола >1 позиции — иначе
    // нечего разворачивать.
    const subItems =
      t.positions.length > 1
        ? t.positions
            .sort((a, b) => b.usd - a.usd)
            .map((sp) => ({
              label: `${sp.posId} · ${sp.itemName}`,
              usd: sp.usd,
              pct: total > 0 ? (sp.usd / total) * 100 : 0,
            }))
        : undefined;
    return {
      key: t.id,
      label: t.name,
      usd: t.usd,
      pct: total > 0 ? (t.usd / total) * 100 : 0,
      count: t.count,
      color: PALETTE[i % PALETTE.length]!,
      ...(subItems && { subItems }),
    };
  });
  if (tailUsd > 0) {
    all.push({
      key: "OTHER",
      label: "Прочее",
      usd: tailUsd,
      pct: total > 0 ? (tailUsd / total) * 100 : 0,
      count: tailCount,
      color: PALETTE[9]!,
    });
  }
  return all;
}

/**
 * Распределение totalAssets по «типу позиции» (PositionKind).
 * Цвета фиксированные per-kind, чтобы при перерисовке Лендинг всегда был
 * warning-amber, LP — blue, Стейкинг — emerald-green, Perp — violet,
 * Другое — neutral. Без sub-items (kind — листовая категория).
 */
const KIND_COLOR: Record<PositionKind, string> = {
  lp: "#3b82f6", // blue-500
  lending: "#fbbf24", // amber-400 (warning)
  staking: "#34d399", // emerald-400 (success)
  perp: "#a78bfa", // violet-400
  other: "#94a3b8", // slate-400
};

function buildKindBreakdown(
  positions: OpenPosition[],
  total: number,
): BreakdownEntry[] {
  const m = new Map<
    PositionKind,
    { usd: number; count: number; positions: { posId: string; itemName: string; usd: number }[] }
  >();
  for (const p of positions) {
    const cur = m.get(p.kind) ?? { usd: 0, count: 0, positions: [] };
    const ta = totalAssetsOf(p);
    cur.usd += ta;
    cur.count += 1;
    cur.positions.push({
      posId: p.id,
      itemName: p.itemName || p.protocol.name,
      usd: ta,
    });
    m.set(p.kind, cur);
  }
  return [...m.entries()]
    .map(([kind, v]) => {
      // subItems: до 8 крупнейших позиций внутри типа (по убыванию totalAssets).
      const subItems =
        v.positions.length > 1
          ? v.positions
              .sort((a, b) => b.usd - a.usd)
              .slice(0, 8)
              .map((sp) => ({
                label: `${sp.posId} · ${sp.itemName}`,
                usd: sp.usd,
                pct: total > 0 ? (sp.usd / total) * 100 : 0,
              }))
          : undefined;
      return {
        key: kind,
        label: KIND_LABEL[kind],
        usd: v.usd,
        pct: total > 0 ? (v.usd / total) * 100 : 0,
        count: v.count,
        color: KIND_COLOR[kind],
        ...(subItems && { subItems }),
      };
    })
    .sort((a, b) => b.usd - a.usd);
}

/**
 * Структура активов — пять donut chart'ов с легендами под ними.
 * 1. По кошелькам (sub-items: протоколы внутри кошелька)
 * 2. По токенам (USDC / WETH / WBTC / Стейблкоины / …)
 * 3. По протоколам (Uniswap V3 / Fluid / Aave / …)
 * 4. По типу позиции (LP / Лендинг / Стейкинг / Perp / Другое)
 * 5. По Total PnL — что приносит больше
 */
function AssetStructureBlock({
  positions,
  compositions,
}: {
  positions: OpenPosition[];
  compositions: AssetCompositions;
}) {
  // total = Σ totalAssets (current + lifetime fees) — соответствует
  // ИТОГО АКТИВЫ в таблице, чтобы fee'и не терялись из структуры.
  const total = positions.reduce((s, p) => s + totalAssetsOf(p), 0);
  const byWallet = useMemo(
    () => buildWalletBreakdown(positions, total),
    [positions, total],
  );
  const byToken = useMemo(
    () => buildTokenBreakdown(positions, total, compositions),
    [positions, total, compositions],
  );
  const byProto = useMemo(() => buildProtocolBreakdown(positions, total), [positions, total]);
  const byKind = useMemo(() => buildKindBreakdown(positions, total), [positions, total]);
  const byPnl = useMemo(() => buildPnlBreakdown(positions), [positions]);

  if (positions.length === 0 || total <= 0) return null;

  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <span className="pointer-events-none absolute inset-x-6 -top-px h-px bg-brand-gradient opacity-70" />
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-brand-cyan" />
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-foreground">
          Структура активов
        </h4>
        <InfoTip
          title="Структура активов"
          body="Пять разрезов распределения по открытым позициям. Считается по ИТОГО АКТИВЫ (текущая стоимость + накопленные fee'и за всё время), чтобы доход от fee'ев не терялся в структуре. По кошелькам — где лежит у кого (hover → протоколы внутри кошелька), по токенам — что лежит, по протоколам — где размещено, по типу — какая доля капитала в LP / Лендинге / Стейкинге / Perp, по Total PnL — что приносит больше."
        />
      </div>
      <div className="grid grid-cols-1 divide-y divide-border/40 sm:grid-cols-2 sm:divide-x md:grid-cols-3 lg:grid-cols-5 lg:divide-y-0">
        <DonutPanel
          title="По кошелькам"
          subtitle="распределение по wallets"
          breakdown={byWallet}
        />
        <DonutPanel
          title="По токенам"
          subtitle="состав активов"
          breakdown={byToken}
        />
        <DonutPanel
          title="По протоколам"
          subtitle="где размещены"
          breakdown={byProto}
        />
        <DonutPanel
          title="По типу позиции"
          subtitle="LP / Лендинг / Стейк / Perp"
          breakdown={byKind}
        />
        <DonutPanel
          title="По Total PnL"
          subtitle="что приносит больше"
          breakdown={byPnl.entries}
          signed
          netTotal={byPnl.netTotal}
        />
      </div>
    </div>
  );
}

/**
 * Колонка с одним donut'ом и интерактивной легендой.
 * - Hover на сегменте/легенде: подсветка + лифт сегмента, остальные затемняются,
 *   центр donut'а показывает данные выбранного сегмента, под легендой
 *   разворачивается sub-breakdown (для агрегатов как «Стейблкоины» / «ETH»).
 */
function DonutPanel({
  title,
  subtitle,
  breakdown,
  signed,
  netTotal,
}: {
  title: string;
  subtitle: string;
  breakdown: BreakdownEntry[];
  /** Если true — usd может быть отрицательным (PnL). Форматируем со знаком, центр показывает netTotal. */
  signed?: boolean;
  /** NET сумма (используется только в signed-режиме для центра donut'а). */
  netTotal?: number;
}) {
  const { locale } = useI18n();
  const fmtSigned = (v: number) =>
    `${v >= 0 ? "+" : ""}${formatUsd(v, locale)}`;
  const fmtVal = signed ? fmtSigned : (v: number) => formatUsd(v, locale);
  const sumDisplay = signed ? netTotal ?? 0 : breakdown.reduce((s, b) => s + b.usd, 0);
  const segments: DonutSegment[] = breakdown.map((b) => ({
    key: b.key,
    pct: b.pct,
    color: b.color,
  }));
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const hoveredEntry = hoveredKey
    ? breakdown.find((b) => b.key === hoveredKey)
    : null;

  return (
    <div className="p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-foreground">
            {title}
          </div>
          <div className="text-[10px] text-muted-foreground">{subtitle}</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            всего
          </div>
          <div
            className={cn(
              "text-sm font-semibold tabular-nums",
              signed && sumDisplay > 0 && "text-success",
              signed && sumDisplay < 0 && "text-destructive",
            )}
          >
            {fmtVal(sumDisplay)}
          </div>
        </div>
      </div>
      <div className="flex flex-col items-center gap-3">
        <AnimatedDonut
          segments={segments}
          size={140}
          stroke={20}
          hoveredKey={hoveredKey}
          onHover={setHoveredKey}
          centerLabel={
            hoveredEntry
              ? {
                  top: hoveredEntry.label,
                  main: fmtVal(hoveredEntry.usd),
                  bottom: `${hoveredEntry.pct.toFixed(1)}%`,
                }
              : {
                  top: signed ? "Net" : "сегментов",
                  main: signed ? fmtVal(sumDisplay) : breakdown.length,
                  bottom: signed
                    ? `${breakdown.length} поз.`
                    : sumDisplay > 0
                      ? formatUsd(sumDisplay, locale)
                      : "—",
                }
          }
        />
        <div className="grid w-full grid-cols-1 gap-1">
          {breakdown.map((b) => {
            const isHovered = hoveredKey === b.key;
            const isOther = hoveredKey != null && !isHovered;
            return (
              <div key={b.key}>
                <button
                  type="button"
                  onMouseEnter={() => setHoveredKey(b.key)}
                  onMouseLeave={() => setHoveredKey(null)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-xs transition-all duration-150",
                    isHovered && "bg-secondary scale-[1.02]",
                    isOther && "opacity-40",
                  )}
                  style={{ transformOrigin: "left center" }}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
                      style={{ backgroundColor: b.color }}
                    />
                    <span
                      className={cn(
                        "truncate font-medium text-foreground",
                        isHovered && "text-brand-cyan",
                      )}
                    >
                      {b.label}
                      {b.subItems && (
                        <span className="ml-1 text-[9px] uppercase text-muted-foreground">
                          ({b.subItems.length})
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="flex flex-shrink-0 items-baseline gap-1.5 tabular-nums">
                    <span
                      className={cn(
                        "font-semibold",
                        signed && b.usd > 0 && "text-success",
                        signed && b.usd < 0 && "text-destructive",
                      )}
                    >
                      {fmtVal(b.usd)}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {b.pct.toFixed(1)}%
                    </span>
                  </div>
                </button>
                {/* Sub-breakdown — раскрывается с анимацией высоты при hover. */}
                {b.subItems && b.subItems.length > 0 && (
                  <div
                    className="grid transition-[grid-template-rows] duration-200 ease-out"
                    style={{ gridTemplateRows: isHovered ? "1fr" : "0fr" }}
                  >
                    <div className="overflow-hidden">
                      <div className="ml-4 mt-1 border-l border-border pl-2">
                        {b.subItems.map((s) => (
                          <div
                            key={s.label}
                            className="flex items-center justify-between gap-2 py-0.5 text-[10px]"
                          >
                            <span className="text-muted-foreground">
                              {s.label}
                            </span>
                            <span className="tabular-nums">
                              <span className="font-medium">
                                {formatUsd(s.usd, locale)}
                              </span>{" "}
                              <span className="text-muted-foreground">
                                {s.pct.toFixed(1)}%
                              </span>
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function FeePillCell({ data }: { data: AnalyticsData }) {
  const { locale } = useI18n();
  const fmt = (v: number) => formatUsd(v, locale);
  const valueLabel =
    data.feesLifetimeUsd > 0 ? `+${fmt(data.feesLifetimeUsd)}` : "—";

  const trigger = (
    <div className="group relative cursor-pointer border-b border-r border-border/40 px-4 py-3 text-left transition-colors hover:bg-secondary/40">
      <div className="mb-1 flex items-center gap-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Fee
        </span>
        <InfoTip
          title="Fee (lifetime)"
          body="Дивиденды по всем позициям за всё время = Pending (накопленные внутри позиции, ещё не сняты) + Claimed (уже сняты, лежат на кошельке). Клик — подробная разбивка по токенам."
        />
        <span className="ml-auto text-[9px] uppercase text-brand-cyan/70 group-hover:text-brand-cyan">
          подробнее
        </span>
      </div>
      <div
        className={cn(
          "tabular-nums font-semibold tracking-tight text-sm",
          data.feesLifetimeUsd > 0 && "text-success",
        )}
      >
        {valueLabel}
      </div>
    </div>
  );

  return (
    <DetailsPopover label={trigger}>
      <div className="space-y-3 p-1 text-xs">
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            Fee — lifetime по всем позициям
          </div>
          <div className="text-lg font-semibold tabular-nums text-success">
            {data.feesLifetimeUsd > 0 ? `+${fmt(data.feesLifetimeUsd)}` : "—"}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 border-t border-border pt-2">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Pending (в позиции)
            </div>
            <div className="tabular-nums font-medium">
              {data.feesPendingUsd > 0 ? `+${fmt(data.feesPendingUsd)}` : "—"}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Claimed (на кошельке)
            </div>
            <div className="tabular-nums font-medium">
              {data.feesClaimedUsd > 0 ? `+${fmt(data.feesClaimedUsd)}` : "—"}
            </div>
          </div>
        </div>
        {data.feesPendingByToken.size > 0 && (
          <div className="border-t border-border pt-2">
            <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              Pending · по токенам
            </div>
            <div className="space-y-1">
              {[...data.feesPendingByToken.entries()]
                .sort((a, b) => b[1].usd - a[1].usd)
                .map(([sym, t]) => (
                  <div key={sym} className="flex items-center justify-between gap-2">
                    <span className="font-mono tabular-nums text-muted-foreground">
                      {formatNumber(t.amount, locale, 6)}{" "}
                      <span className="text-foreground/80">{sym}</span>
                    </span>
                    <span className="tabular-nums font-medium text-success">
                      +{fmt(t.usd)}
                    </span>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>
    </DetailsPopover>
  );
}

/**
 * Toggle-пилюля «Свой / Кредит» для пометки позиции как кредитной.
 * Заменяет крошечный чекбокс — клик по пилюле сразу переключает состояние,
 * визуально очень заметно (cyan vs warning yellow с иконкой банка).
 */
function CapitalToggle({
  isCredit,
  currentUsd,
  onToggle,
}: {
  isCredit: boolean;
  currentUsd: number;
  onToggle: () => void;
}) {
  const { locale } = useI18n();
  return (
    <Tooltip
      maxWidth={260}
      content={
        <div className="space-y-1">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-brand-cyan">
            {isCredit ? "Кредитная позиция" : "Свой капитал"}
          </div>
          <div className="text-xs leading-relaxed text-foreground/90">
            {isCredit
              ? `Помечена как профинансированная из кредитных средств. Вся текущая стоимость (${formatUsd(currentUsd, locale)}) идёт в "Кредитный капитал". Клик — снять метку.`
              : "Позиция считается купленной за свои средства. Клик — пометить как кредитную, и её стоимость попадёт в Кредитный капитал."}
          </div>
        </div>
      }
    >
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={isCredit}
        className={cn(
          "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider transition-all hover:scale-105",
          isCredit
            ? "border-warning bg-warning/15 text-warning shadow-sm shadow-warning/20"
            : "border-border bg-secondary text-muted-foreground hover:border-brand-cyan/40 hover:text-foreground",
        )}
      >
        {isCredit ? <Landmark className="h-3 w-3" /> : null}
        {isCredit ? "Кредит" : "Свой"}
      </button>
    </Tooltip>
  );
}

function PnlCell({ usd, pct }: { usd: number; pct: number | null }) {
  const { locale } = useI18n();
  // pct === null → startUsd неизвестна/≈0 (cost basis incomplete). Показываем
  // ⚠ вместо абсурдного % И вместо misleading $ (который ≈ currentUsd, когда
  // start ≈ 0). Симметрично FeeAprCell.
  if (pct === null) {
    return (
      <span
        className="text-amber-500 font-medium inline-flex items-center gap-1 cursor-help"
        title={
          "PnL недостоверен: стартовая сумма (cost basis) неизвестна или ≈0 — " +
          "classifier мог не захватить deposit (напр. Velodrome gauge-staked). " +
          "Проверьте детали позиции."
        }
      >
        ⚠ —
      </span>
    );
  }
  const positive = usd >= 0;
  return (
    <>
      <span className={cn("font-medium", positive ? "text-success" : "text-destructive")}>
        {positive ? "+" : ""}
        {formatUsd(usd, locale)}
      </span>{" "}
      <span className={cn("text-[10px]", positive ? "text-success" : "text-destructive")}>
        ({positive ? "+" : ""}
        {pct.toFixed(2)}%)
      </span>
    </>
  );
}

/* -------------------- HF badge -------------------- */

/**
 * Цвет уровня здоровья позиции:
 *   HF >= 1.5     — зелёный (запас здоровья большой)
 *   1.15 ≤ HF < 1.5 — оранжевый (обратить внимание)
 *   HF < 1.15     — красный с пульсирующей точкой (риск ликвидации)
 */
function HfBadge({ hf }: { hf: number }) {
  const danger = hf < 1.15;
  const warning = !danger && hf < 1.5;
  const color = danger
    ? "text-destructive"
    : warning
      ? "text-warning"
      : "text-success";
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1 text-[10px] font-bold leading-tight",
        color,
      )}
    >
      HF {hf.toFixed(2)}
      {danger && (
        <span className="relative inline-flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-destructive" />
        </span>
      )}
    </div>
  );
}

/* -------------------- Fee popover cells -------------------- */

function FeesUsdCell({ p }: { p: OpenPosition }) {
  const { locale } = useI18n();
  const pending = p.feesUsd ?? 0;
  const claimed = p.feesClaimedUsd;
  const lifetime = p.feesLifetimeUsd;
  const history = p.feesClaimedHistory ?? [];

  // 2026-05-25 (Derbent21 audit POS-003): sanity guard. Если lifetime
  // fees > 5× startUsd — cost basis incomplete, fees inflated.
  // Показываем число с амбер-warning вместо зелёного и tooltip.
  const isAbsurd = p.startUsd > 0 && lifetime > p.startUsd * 5;

  return (
    <DetailsPopover
      label={
        isAbsurd ? (
          <span
            className="text-amber-500 font-medium inline-flex items-center gap-1"
            title={
              `Fees ($${lifetime.toFixed(0)}) сильно превышают cost basis ($${p.startUsd.toFixed(0)}).\n` +
              `Cost basis incomplete — classifier мог пропустить часть deposit ops.`
            }
          >
            ⚠ +{formatUsd(lifetime, locale)}
            <Info className="h-3 w-3 opacity-60" />
          </span>
        ) : (
          <span className="text-success font-medium inline-flex items-center gap-1">
            +{formatUsd(lifetime, locale)}
            <Info className="h-3 w-3 opacity-60" />
          </span>
        )
      }
    >
      <div className="space-y-1.5 min-w-[260px]">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Fee — lifetime
        </div>
        <div className="space-y-0.5 text-xs">
          <Row label="Pending (в позиции)" value={`+${formatUsd(pending, locale)}`} />
          <Row label="Claimed (на кошельке)" value={`+${formatUsd(claimed, locale)}`} />
          <div className="border-t border-border/40 pt-1">
            <Row
              label="Σ Lifetime"
              value={
                <span className="text-success font-medium">
                  +{formatUsd(lifetime, locale)}
                </span>
              }
            />
          </div>
        </div>
        <div className="border-t border-border/40 pt-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
          {p.feesSource === "v3_rewards" ? "Pending · по токенам" : "Pending yield · по токенам"}
        </div>
        {p.feesByToken.map((t) => (
          <div
            key={t.symbol}
            className="flex items-center justify-between gap-3 text-xs"
          >
            <span className="text-muted-foreground">{t.symbol}</span>
            <span className="text-right tabular-nums">
              <span className="font-mono">+{formatNumber(t.amount, locale, 8)}</span>
              <div className="text-[10px] text-success/80">
                ≈ +{formatUsd(t.usd, locale)}
              </div>
            </span>
          </div>
        ))}
        {history.length > 0 && (
          <>
            <div className="border-t border-border/40 pt-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              Хронология снятий ({history.length})
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[10.5px] tabular-nums">
                <thead className="text-muted-foreground">
                  <tr className="text-left">
                    <th className="pr-2 py-0.5 font-normal">Дата</th>
                    <th className="pr-2 py-0.5 font-normal text-right">Sum $</th>
                    <th className="pr-2 py-0.5 font-normal text-right">APR за период</th>
                    <th className="py-0.5 font-normal text-right">Дней</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((ev, i) => {
                    const prevUsd = i === 0 ? null : history[i - 1]!.usd;
                    const pnlAbs = prevUsd != null ? ev.usd - prevUsd : null;
                    const pnlPct =
                      prevUsd != null && prevUsd > 0
                        ? (pnlAbs! / prevUsd) * 100
                        : null;
                    return (
                      <tr key={ev.hash} className="border-t border-border/20">
                        <td className="pr-2 py-0.5 whitespace-nowrap">
                          {formatDateShort(ev.time)}
                        </td>
                        <td className="pr-2 py-0.5 text-right text-success">
                          +{formatUsd(ev.usd, locale)}
                          {pnlAbs != null && (
                            <div
                              className={cn(
                                "text-[9.5px]",
                                pnlAbs >= 0 ? "text-success/70" : "text-destructive/80",
                              )}
                            >
                              {pnlAbs >= 0 ? "+" : ""}
                              {formatUsd(pnlAbs, locale)}
                              {pnlPct != null && ` (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)`}
                            </div>
                          )}
                        </td>
                        <td className="pr-2 py-0.5 text-right">
                          {ev.aprPeriod != null
                            ? `${ev.aprPeriod.toFixed(1)}%`
                            : "—"}
                        </td>
                        <td className="py-0.5 text-right text-muted-foreground">
                          {ev.daysSincePrev != null
                            ? ev.daysSincePrev.toFixed(1)
                            : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="text-[9.5px] text-muted-foreground pt-0.5 leading-tight">
              APR baseline = startUsd. PnL рядом с Sum — разница к предыдущему snim'у.
            </div>
          </>
        )}
      </div>
    </DetailsPopover>
  );
}

function FeeAprCell({ p }: { p: OpenPosition }) {
  const hasNative = p.feesByToken.some((t) => t.nativeApr != null);
  const aprLifetime = p.feeAprLifetime ?? 0;
  const aprPending = p.feeApr ?? 0;

  // 2026-05-25 (Derbent21 audit POS-003): sanity guard для absurd APR.
  // Если feesUsd выпрыгивает выше 5× startUsd (для lending — невозможно
  // даже при максимальных аave rates) ИЛИ feeAprLifetime > 1000% —
  // cost basis incomplete (classifier пропустил supply ops). Показываем
  // «—» с warning tooltip вместо misleading 459% / 5757%.
  const isAbsurd =
    aprLifetime > 1000 ||
    (p.startUsd > 0 && (p.feesUsd ?? 0) + p.feesClaimedUsd > p.startUsd * 5);

  if (isAbsurd) {
    return (
      <span
        className="text-amber-500 font-medium inline-flex items-center gap-1 cursor-help"
        title={
          `Fee APR недостоверен (рассчитано ${aprLifetime.toFixed(0)}%).\n` +
          `feesUsd $${((p.feesUsd ?? 0) + p.feesClaimedUsd).toFixed(0)} ` +
          `на startUsd $${p.startUsd.toFixed(0)} — cost basis incomplete ` +
          `(classifier мог пропустить часть deposit ops). Проверьте детали позиции.`
        }
      >
        ⚠ —
      </span>
    );
  }

  return (
    <DetailsPopover
      label={
        <span className="text-success font-medium inline-flex items-center gap-1">
          {aprLifetime.toFixed(2)}%
          <Info className="h-3 w-3 opacity-60" />
        </span>
      }
    >
      <div className="space-y-1 min-w-[220px]">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Fee APR
        </div>
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="text-muted-foreground">Lifetime (pending + claimed)</span>
          <span className="font-medium tabular-nums text-success">
            {aprLifetime.toFixed(2)}%
          </span>
        </div>
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="text-muted-foreground">Только pending</span>
          <span className="font-medium tabular-nums text-success">
            {aprPending.toFixed(2)}%
          </span>
        </div>
        {hasNative && (
          <div className="border-t border-border/40 pt-1 space-y-0.5">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              По токенам (pending native APR)
            </div>
            {p.feesByToken
              .filter((t) => t.nativeApr != null)
              .map((t) => (
                <div
                  key={t.symbol}
                  className="flex items-center justify-between gap-3 text-xs"
                >
                  <span className="text-muted-foreground">{t.symbol} APR</span>
                  <span className="font-medium tabular-nums text-success">
                    {t.nativeApr!.toFixed(2)}%
                  </span>
                </div>
              ))}
          </div>
        )}
        <div className="border-t border-border/40 pt-1 text-[10px] text-muted-foreground leading-snug">
          Lifetime включает уже снятые fees (claim_rewards) — даёт реальный
          годовой выход с позиции.
        </div>
      </div>
    </DetailsPopover>
  );
}

/** Кнопка-иконка для V3 позиции — открывает попап с диапазонами,
 *  пропорциями, HODL и IL. */
function V3InfoButton({
  p,
  onChain,
}: {
  p: OpenPosition;
  onChain: V3Position[];
}) {
  const { locale } = useI18n();
  const v3 = p.v3;
  // 2026-05-25 (Derbent21 audit): рендерим partial popup даже если
  // p.v3 = null. Раньше return null блокировал popup для экзотических
  // пар (PAXG/XAUt, etc.) где Etherscan не нашёл IncreaseLiquidity events.
  // Нужно: onChain[0] (NFT range data из Alchemy) — ranges + exit
  // scenarios available, только IL/HODL/PnL vs deposit secции скрываем.
  if (!v3 && !onChain[0]) return null;

  const hasIL = v3 && v3.hodlUsd > 0;
  const ilPct = hasIL ? (v3.impermanentLossUsd / v3.hodlUsd) * 100 : 0;

  // Use on-chain NPM read как single source of truth (consistent с exit scenarios).
  // Match symbols к p.supplyTokens для USD-цен (post-override prices).
  const priceBySym = new Map<string, number>();
  for (const t of p.supplyTokens) {
    if (t.amount > 0 && t.currentUsd > 0) {
      priceBySym.set(canonicalSymbol(t.symbol), t.currentUsd / t.amount);
    }
  }
  const displayTokens = onChain[0]
    ? [
        {
          symbol: onChain[0].token0.symbol,
          amount: onChain[0].amount0Current,
          usd: onChain[0].amount0Current * (priceBySym.get(canonicalSymbol(onChain[0].token0.symbol)) ?? 0),
        },
        {
          symbol: onChain[0].token1.symbol,
          amount: onChain[0].amount1Current,
          usd: onChain[0].amount1Current * (priceBySym.get(canonicalSymbol(onChain[0].token1.symbol)) ?? 0),
        },
      ]
    : p.supplyTokens.map((t) => ({ symbol: t.symbol, amount: t.amount, usd: t.currentUsd }));
  const totalCurrent = displayTokens.reduce((s, t) => s + t.usd, 0);

  return (
    <DetailsPopover
      label={
        <span
          className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-blue-500/40 bg-blue-500/10 text-blue-400"
          title="V3 LP детали"
        >
          <Info className="h-3 w-3" />
        </span>
      }
    >
      <div className="w-[360px] space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Concentrated liquidity (V3)
          </div>
          {hasIL ? (
            <div
              className={cn(
                "text-[10px]",
                v3!.impermanentLossUsd > 0
                  ? "text-destructive"
                  : v3!.impermanentLossUsd < 0
                    ? "text-success"
                    : "text-muted-foreground",
              )}
              title={`HODL ${formatUsd(v3!.hodlUsd, locale)} · LP ${formatUsd(v3!.currentLpUsd, locale)}`}
            >
              IL {v3!.impermanentLossUsd > 0 ? "−" : v3!.impermanentLossUsd < 0 ? "+" : ""}
              {formatUsd(Math.abs(v3!.impermanentLossUsd), locale)} ·{" "}
              {ilPct > 0 ? "−" : ilPct < 0 ? "+" : ""}
              {Math.abs(ilPct).toFixed(2)}%
            </div>
          ) : (
            <div
              className="text-[10px] text-muted-foreground"
              title="IL и PnL vs депозит недоступны — нет данных о mint этой NFT (Etherscan не вернул IncreaseLiquidity events)."
            >
              IL —
            </div>
          )}
        </div>

        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Сейчас в позиции
          </div>
          {displayTokens.map((t) => {
            const pct = totalCurrent > 0 ? (t.usd / totalCurrent) * 100 : 0;
            return (
              <Row
                key={t.symbol}
                label={t.symbol}
                value={
                  <>
                    {formatNumber(t.amount, locale, 6)}
                    <span className="text-muted-foreground"> · {pct.toFixed(1)}%</span>
                  </>
                }
              />
            );
          })}
        </div>

        {onChain.length > 0 ? (
          onChain.map((pos) => (
            <V3RangeBlock
              key={pos.tokenId.toString()}
              pos={pos}
              depositUsd={v3?.depositUsd ?? 0}
              depositTokens={v3?.depositTokens ?? []}
            />
          ))
        ) : (
          <div className="text-[10px] text-muted-foreground leading-snug">
            Диапазоны не загружены — добавьте Alchemy ключ в Настройки →
            Интеграции.
          </div>
        )}
      </div>
    </DetailsPopover>
  );
}

function V3RangeBlock({
  pos,
  depositUsd,
  depositTokens,
}: {
  pos: V3Position;
  depositUsd: number;
  depositTokens: { symbol: string; amount: number; usdAtDeposit: number }[];
}) {
  const { locale } = useI18n();
  const fmtPrice = (n: number) =>
    n >= 1
      ? formatNumber(n, locale, 4)
      : n >= 0.01
        ? formatNumber(n, locale, 6)
        : n.toExponential(3);
  const fmtAmount = (n: number) => formatNumber(n, locale, 6);

  const pair = `${pos.token1.symbol}/${pos.token0.symbol}`;
  const feeLabel = `${(pos.feeTier / 10000).toFixed(2)}%`;

  // Базовый кейс: token1 — quote (стейбл), token0 — base. Если token1 не
  // стейбл, exit-up даёт сумму в token1 без USD-фиксации.
  const quoteIsStable = isStableSymbol(pos.token1.symbol);
  const baseIsStable = isStableSymbol(pos.token0.symbol);

  // Сколько base продастся / quote получится при exit-up (Pb).
  const soldBase = pos.amount0Current; // → 0 на Pb
  const receivedQuote = pos.amount1AtPb - pos.amount1Current;
  const avgSellPrice =
    soldBase > 0 ? receivedQuote / soldBase : null;

  // Сколько base докупится / quote потратится при exit-down (Pa).
  const boughtBase = pos.amount0AtPa - pos.amount0Current;
  const spentQuote = pos.amount1Current; // → 0 на Pa
  const avgBuyPrice = boughtBase > 0 ? spentQuote / boughtBase : null;

  // Депозит — найти amount каждого токена. Нормализуем wrap-обёртки
  // (WETH ↔ ETH, WBTC ↔ BTC, ...) — DeBank отдаёт символы как у нативного
  // актива, а V3 пул работает с обёрнутой версией.
  const depAmount0 = findDepositAmount(depositTokens, pos.token0.symbol);
  const depAmount1 = findDepositAmount(depositTokens, pos.token1.symbol);

  // 2026-05-25 (Derbent21 audit): если depositUsd<=0 (V3 popup для NFT
  // без mint history — экзотические пары PAXG/XAUt, etc.) — PnL vs
  // deposit + Безубыток не имеют смысла. Range/exit amounts всё равно
  // показываем.
  const hasDeposit = depositUsd > 0;

  // PnL и P_break при exit-down (Pa). Считаем когда quote — стейбл И есть deposit.
  let pnlAtPa: { lpUsd: number; lpDeltaUsd: number; lpDeltaPct: number; vsHoldUsd: number; pBreakDown: number | null } | null = null;
  if (quoteIsStable && hasDeposit) {
    const lpUsd = pos.amount0AtPa * pos.priceLower + pos.amount1AtPa * 1;
    const hodlUsd = depAmount0 * pos.priceLower + depAmount1 * 1;
    pnlAtPa = {
      lpUsd,
      lpDeltaUsd: lpUsd - depositUsd,
      lpDeltaPct: depositUsd > 0 ? ((lpUsd - depositUsd) / depositUsd) * 100 : 0,
      vsHoldUsd: lpUsd - hodlUsd,
      pBreakDown: pos.amount0AtPa > 0 ? depositUsd / pos.amount0AtPa : null,
    };
  }

  // PnL при exit-up (Pb). Когда quote — стейбл, итог фиксирован.
  let pnlAtPb: { lpUsd: number; lpDeltaUsd: number; lpDeltaPct: number; vsHoldUsd: number; pBreakUp: number | null; lockedInQuote: boolean } | null = null;
  if (quoteIsStable && hasDeposit) {
    const lpUsd = pos.amount1AtPb;
    const hodlUsd = depAmount0 * pos.priceUpper + depAmount1 * 1;
    pnlAtPb = {
      lpUsd,
      lpDeltaUsd: lpUsd - depositUsd,
      lpDeltaPct: depositUsd > 0 ? ((lpUsd - depositUsd) / depositUsd) * 100 : 0,
      vsHoldUsd: lpUsd - hodlUsd,
      pBreakUp: null, // итог в стейбле — не зависит от цены
      lockedInQuote: true,
    };
  } else if (baseIsStable) {
    // Зеркальный кейс: token0 — стейбл, token1 — base. Не реализуем сейчас, оставим null.
  }

  const fmtUsdSigned = (n: number) =>
    `${n >= 0 ? "+" : "−"}${formatUsd(Math.abs(n), locale)}`;
  const fmtPctSigned = (n: number) =>
    `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`;

  return (
    <div className="rounded border border-border/60 bg-secondary/40 p-1.5 space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-[10px]">
        <span className="font-mono text-muted-foreground truncate">
          {pos.protocolLabel} · #{pos.tokenId.toString()} · fee {feeLabel}
        </span>
        <span
          className={cn(
            "rounded px-1.5 py-0.5",
            pos.inRange
              ? "bg-success/15 text-success"
              : "bg-destructive/15 text-destructive",
          )}
        >
          {pos.inRange ? "В диапазоне" : "Вне диапазона"}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <div className="text-[10px] text-muted-foreground">Pa</div>
          <div className="font-mono tabular-nums">{fmtPrice(pos.priceLower)}</div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground">Сейчас</div>
          <div className="font-mono tabular-nums">{fmtPrice(pos.currentPrice)}</div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground">Pb</div>
          <div className="font-mono tabular-nums">{fmtPrice(pos.priceUpper)}</div>
        </div>
      </div>
      <div className="text-[10px] text-muted-foreground">Цена в {pair}</div>

      {/* Exit ↑ Pb */}
      <div className="rounded border border-border/40 bg-background/40 p-1.5 space-y-0.5 text-xs">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          ↑ Выход вверх (Pb {fmtPrice(pos.priceUpper)})
        </div>
        <div className="rounded border border-success/40 bg-success/10 px-2 py-1.5 my-1">
          <div className="text-[9.5px] uppercase tracking-wider text-success/80">
            Получит на баланс
          </div>
          <div className="font-mono tabular-nums text-sm font-semibold text-success">
            {fmtAmount(pos.amount1AtPb)} {pos.token1.symbol}
            {quoteIsStable && (
              <span className="text-muted-foreground/80 font-normal ml-1.5 text-xs">
                ≈ {formatUsd(pos.amount1AtPb, locale)}
              </span>
            )}
          </div>
          {avgSellPrice != null && pos.amount0Current > 0 && (
            <div className="text-[10.5px] text-success/90 mt-0.5">
              {pos.token0.symbol} продан по avg{" "}
              <span className="font-mono">{fmtPrice(avgSellPrice)}</span> {pair}
            </div>
          )}
        </div>
        {avgSellPrice != null ? (
          <>
            <Row label={`Продаст ${pos.token0.symbol}`} value={fmtAmount(soldBase)} />
            <Row label={`Средняя цена`} value={fmtPrice(avgSellPrice)} />
          </>
        ) : (
          <div className="text-muted-foreground">
            Уже выше Pb — полностью в {pos.token1.symbol}.
          </div>
        )}
        {pnlAtPb && (
          <>
            <Row
              label="PnL vs депозит"
              value={
                <span className={pnlAtPb.lpDeltaUsd >= 0 ? "text-success" : "text-destructive"}>
                  {fmtUsdSigned(pnlAtPb.lpDeltaUsd)} · {fmtPctSigned(pnlAtPb.lpDeltaPct)}
                </span>
              }
            />
            <Row
              label="vs HODL"
              value={
                <span className={pnlAtPb.vsHoldUsd >= 0 ? "text-success" : "text-destructive"}>
                  {fmtUsdSigned(pnlAtPb.vsHoldUsd)}
                </span>
              }
            />
          </>
        )}
      </div>

      {/* Exit ↓ Pa */}
      <div className="rounded border border-border/40 bg-background/40 p-1.5 space-y-0.5 text-xs">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          ↓ Выход вниз (Pa {fmtPrice(pos.priceLower)})
        </div>
        <div className="rounded border border-success/40 bg-success/10 px-2 py-1.5 my-1">
          <div className="text-[9.5px] uppercase tracking-wider text-success/80">
            Получит на баланс
          </div>
          <div className="font-mono tabular-nums text-sm font-semibold text-success">
            {fmtAmount(pos.amount0AtPa)} {pos.token0.symbol}
            <span className="text-muted-foreground/80 font-normal ml-1.5 text-xs">
              ≈ {formatUsd(pos.amount0AtPa * pos.priceLower, locale)} @ Pa
            </span>
          </div>
          {pos.amount0AtPa > 0 && depositUsd > 0 && (
            <div className="text-[10.5px] text-success/90 mt-0.5">
              Получит{" "}
              <span className="font-mono">{fmtAmount(pos.amount0AtPa)}</span>{" "}
              {pos.token0.symbol} по цене{" "}
              <span className="font-mono">{fmtPrice(depositUsd / pos.amount0AtPa)}</span> {pair}
              <div className="text-muted-foreground text-[9.5px]">
                ({formatUsd(depositUsd, locale)} депозит ÷ {fmtAmount(pos.amount0AtPa)} {pos.token0.symbol})
              </div>
            </div>
          )}
        </div>
        {avgBuyPrice != null ? (
          <>
            <Row label={`Докупит ${pos.token0.symbol}`} value={fmtAmount(boughtBase)} />
            <Row label="Средняя цена" value={fmtPrice(avgBuyPrice)} />
          </>
        ) : (
          <div className="text-muted-foreground">
            Уже ниже Pa — полностью в {pos.token0.symbol}.
          </div>
        )}
        {pnlAtPa && (
          <>
            <Row
              label="PnL vs депозит"
              value={
                <span className={pnlAtPa.lpDeltaUsd >= 0 ? "text-success" : "text-destructive"}>
                  {fmtUsdSigned(pnlAtPa.lpDeltaUsd)} · {fmtPctSigned(pnlAtPa.lpDeltaPct)}
                </span>
              }
            />
            <Row
              label="vs HODL"
              value={
                <span className={pnlAtPa.vsHoldUsd >= 0 ? "text-success" : "text-destructive"}>
                  {fmtUsdSigned(pnlAtPa.vsHoldUsd)}
                </span>
              }
            />
            {pnlAtPa.pBreakDown != null && (
              <>
                <Row
                  label={`Безубыток ${pos.token0.symbol}`}
                  value={`${fmtPrice(pnlAtPa.pBreakDown)} ${pair}`}
                />
                <div className="text-[10px] text-muted-foreground leading-snug pt-0.5">
                  При фиксации в {pos.token0.symbol} нужен рост до{" "}
                  {fmtPrice(pnlAtPa.pBreakDown)} {pair} — тогда продажа
                  вернёт депозит {formatUsd(depositUsd, locale)}.
                </div>
              </>
            )}
          </>
        )}
      </div>

      {!quoteIsStable && (
        <div className="text-[10px] text-warning leading-snug">
          Квота {pos.token1.symbol} — не стейбл. PnL и P_break относительно $
          неточны.
        </div>
      )}
    </div>
  );
}

/** Канонизация символа: убираем wrap-префикс, чтобы WETH сматчился с ETH,
 *  WBTC — с BTC, и т.д. Stable-варианты (USDT/USDC/DAI) не трогаем. */
function canonicalSymbol(sym: string): string {
  const s = sym.toUpperCase();
  const WRAPPED: Record<string, string> = {
    WETH: "ETH",
    WBTC: "BTC",
    WMATIC: "MATIC",
    WAVAX: "AVAX",
    WBNB: "BNB",
    WSOL: "SOL",
    WFTM: "FTM",
  };
  return WRAPPED[s] ?? s;
}

function findDepositAmount(
  depositTokens: { symbol: string; amount: number }[],
  poolSymbol: string,
): number {
  const target = canonicalSymbol(poolSymbol);
  return (
    depositTokens.find((t) => canonicalSymbol(t.symbol) === target)?.amount ?? 0
  );
}

function Row({ label, value }: { label: React.ReactNode; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="font-mono tabular-nums text-right truncate">{value}</span>
    </div>
  );
}

/** Click-popover с порталом в body и fixed-позиционированием. Сам считает
 *  координаты по rect триггера, корректирует, если не влезает в viewport,
 *  и ограничивает высоту так, чтобы скролл шёл внутри панели — а не страницы. */
function DetailsPopover({
  label,
  children,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    maxHeight: number;
  } | null>(null);

  // Считаем позицию каждый раз, когда открываем (или при resize/scroll окна).
  useEffect(() => {
    if (!open) return;
    function place() {
      const t = triggerRef.current?.getBoundingClientRect();
      if (!t) return;
      const margin = 8;
      const desiredW = panelRef.current?.offsetWidth ?? 360;
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      // Низ предпочтительнее, если хватает места; иначе сверху.
      const spaceBelow = vh - t.bottom - margin;
      const spaceAbove = t.top - margin;
      const placeBelow = spaceBelow >= 240 || spaceBelow >= spaceAbove;
      const top = placeBelow ? t.bottom + 4 : Math.max(margin, t.top - 4);
      const maxHeight = placeBelow ? spaceBelow : spaceAbove;
      // Right-align к иконке, но не выезжаем за левый край viewport.
      const rawLeft = t.right - desiredW;
      const left = Math.max(margin, Math.min(rawLeft, vw - desiredW - margin));
      setPos({
        top: placeBelow ? top : top - (panelRef.current?.offsetHeight ?? 0),
        left,
        maxHeight: Math.max(160, maxHeight),
      });
    }
    place();
    // requestAnimationFrame — после того как панель отрендерилась с реальной
    // высотой, пересчитаем (для placeAbove нужна высота).
    const raf = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const tgt = e.target as Node;
      if (triggerRef.current?.contains(tgt)) return;
      if (panelRef.current?.contains(tgt)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="cursor-pointer hover:opacity-80"
      >
        {label}
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            style={{
              position: "fixed",
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              maxHeight: pos?.maxHeight,
            }}
            className="z-50 overflow-y-auto rounded-md border border-border bg-popover p-2 text-left shadow-md"
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}

function Header({ action }: { action?: React.ReactNode }) {
  const t = useT();
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("nav.performance")}
        </h1>
        <p className="text-sm text-muted-foreground">
          Все DeFi-сабпозиции по всем кошелькам — каждая отдельной строкой,
          с матчем к live-стоимости и PnL по средневзвешенной покупке актива.
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
  align?: "right" | "center" | "left";
}) {
  return (
    <th
      className={cn(
        "px-2.5 py-2 font-medium whitespace-nowrap",
        align === "right"
          ? "text-right"
          : align === "center"
            ? "text-center"
            : "text-left",
      )}
    >
      {children}
    </th>
  );
}

function Stat({
  label,
  value,
  hint,
  accent,
  compact,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: "success" | "destructive";
  compact?: boolean;
}) {
  if (compact) {
    return (
      <div className="rounded border border-border/60 bg-background/40 px-2 py-1.5">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <div
          className={cn(
            "tabular-nums font-medium",
            accent === "success" && "text-success",
            accent === "destructive" && "text-destructive",
          )}
        >
          {value}
        </div>
      </div>
    );
  }
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <div
          className={cn(
            "mt-1 text-xl font-semibold tracking-tight tabular-nums",
            accent === "success" && "text-success",
            accent === "destructive" && "text-destructive",
          )}
        >
          {value}
        </div>
        {hint && <div className="text-[11px] text-warning">{hint}</div>}
      </CardContent>
    </Card>
  );
}

// Chip перемещён в @/components/ui/Chip — используется и в Registry.

/* ----------------------- Сводный фильтр-дропдаун --------------------------- */

/**
 * Multi-select filter panel (PR #5).
 *
 * Filters покрывают все измерения отображаемые в Open Positions list:
 *   - Источник (single, broad): EVM / Solana / CoinStats
 *   - Кошелёк (multi): любая комбинация из загруженных
 *   - Тип позиции (multi): LP / Lending / Staking / Perp / Other
 *   - Chain (multi): eth / arb / op / base / matic / sol / etc.
 *   - Протокол (multi): Uniswap V3 / Aave V3 / GMX / Pendle / etc.
 *   - PnL знак (radio): прибыль / убыток / все
 *   - V3 range (radio): in-range / out-of-range / все
 *   - Только с pending fee (toggle)
 *   - Только с долгом (toggle)
 *
 * Empty Set = «все» (no filter). Chip toggle adds/removes from Set.
 * Кнопка показывает Σ активных не-default фильтров для badge'а.
 */
function FiltersDropdown({
  groupFilter,
  setGroupFilter,
  walletFilter,
  toggleWallet,
  clearWallets,
  kindFilter,
  toggleKind,
  clearKinds,
  chainFilter,
  toggleChain,
  clearChains,
  protocolFilter,
  toggleProtocol,
  clearProtocols,
  filterPnL,
  setFilterPnL,
  filterRange,
  setFilterRange,
  filterHasFee,
  setFilterHasFee,
  filterHasDebt,
  setFilterHasDebt,
  groupCounts,
  loadedList,
  allPositions,
}: {
  groupFilter: ChainGroup | "all";
  setGroupFilter: (v: ChainGroup | "all") => void;
  walletFilter: ReadonlySet<string>;
  toggleWallet: (id: string) => void;
  clearWallets: () => void;
  kindFilter: ReadonlySet<PositionKind>;
  toggleKind: (k: PositionKind) => void;
  clearKinds: () => void;
  chainFilter: ReadonlySet<string>;
  toggleChain: (c: string) => void;
  clearChains: () => void;
  protocolFilter: ReadonlySet<string>;
  toggleProtocol: (id: string) => void;
  clearProtocols: () => void;
  filterPnL: "all" | "profit" | "loss";
  setFilterPnL: (v: "all" | "profit" | "loss") => void;
  filterRange: "all" | "in" | "out";
  setFilterRange: (v: "all" | "in" | "out") => void;
  filterHasFee: boolean;
  setFilterHasFee: (v: boolean) => void;
  filterHasDebt: boolean;
  setFilterHasDebt: (v: boolean) => void;
  groupCounts: Record<ChainGroup, number>;
  loadedList: { wallet: SavedWallet }[];
  allPositions: OpenPosition[];
}) {
  const visibleGroups = (["evm", "sol", "coinstats"] as const).filter(
    (g) => groupCounts[g] > 0,
  );
  const showGroupRow = visibleGroups.length > 1;
  const showWalletRow = loadedList.length > 1;

  // Кошельки фильтруются по выбранной chain-группе.
  const visibleWallets = loadedList.filter(
    (l) =>
      groupFilter === "all" || chainGroupOfWallet(l.wallet) === groupFilter,
  );

  // Уникальные chains/protocols выводим из текущих positions (только то
  // что реально есть в портфеле, нет смысла показывать chain без позиций).
  const chainsInUse = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of allPositions) m.set(p.chain, (m.get(p.chain) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [allPositions]);
  const protocolsInUse = useMemo(() => {
    const m = new Map<string, { name: string; count: number }>();
    for (const p of allPositions) {
      const cur = m.get(p.protocol.id) ?? { name: p.protocol.name, count: 0 };
      cur.count += 1;
      m.set(p.protocol.id, cur);
    }
    return [...m.entries()]
      .map(([id, v]) => ({ id, name: v.name, count: v.count }))
      .sort((a, b) => b.count - a.count);
  }, [allPositions]);

  // Кол-во активных не-default фильтров — для бейджа на кнопке.
  let activeCount = 0;
  if (groupFilter !== "all") activeCount++;
  if (walletFilter.size > 0) activeCount++;
  if (kindFilter.size > 0) activeCount++;
  if (chainFilter.size > 0) activeCount++;
  if (protocolFilter.size > 0) activeCount++;
  if (filterPnL !== "all") activeCount++;
  if (filterRange !== "all") activeCount++;
  if (filterHasFee) activeCount++;
  if (filterHasDebt) activeCount++;

  // Подпись кнопки: «Фильтр» если ничего не выбрано, иначе короткая
  // сводка количеств активных секций.
  const buttonSummary = (() => {
    if (activeCount === 0) return "Фильтр";
    const parts: string[] = [];
    if (groupFilter !== "all") parts.push(CHAIN_GROUP_LABEL[groupFilter]);
    if (walletFilter.size === 1) {
      const w = loadedList.find((l) => walletFilter.has(l.wallet.id));
      if (w) parts.push(w.wallet.name);
    } else if (walletFilter.size > 1) {
      parts.push(`${walletFilter.size} кошельков`);
    }
    if (kindFilter.size === 1) {
      const k = [...kindFilter][0]!;
      parts.push(KIND_LABEL[k]);
    } else if (kindFilter.size > 1) {
      parts.push(`${kindFilter.size} типов`);
    }
    if (chainFilter.size > 0) parts.push(`${chainFilter.size} chain`);
    if (protocolFilter.size > 0) parts.push(`${protocolFilter.size} проток.`);
    if (filterPnL === "profit") parts.push("прибыль");
    if (filterPnL === "loss") parts.push("убыток");
    if (filterRange === "in") parts.push("в диап.");
    if (filterRange === "out") parts.push("вне диап.");
    if (filterHasFee) parts.push("с fee");
    if (filterHasDebt) parts.push("с долгом");
    // Truncate to keep button reasonable.
    return parts.slice(0, 3).join(" · ") + (parts.length > 3 ? " …" : "");
  })();

  const resetAll = () => {
    setGroupFilter("all");
    clearWallets();
    clearKinds();
    clearChains();
    clearProtocols();
    setFilterPnL("all");
    setFilterRange("all");
    setFilterHasFee(false);
    setFilterHasDebt(false);
  };

  const trigger = (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-md border border-border bg-secondary px-3 py-2 text-sm transition-colors hover:border-brand-cyan/40 hover:text-foreground",
        activeCount > 0 ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <SlidersHorizontal className="h-4 w-4" />
      <span className="font-medium">{buttonSummary}</span>
      {activeCount > 0 && (
        <Badge variant="muted" className="text-[10px]">
          {activeCount}
        </Badge>
      )}
    </span>
  );

  return (
    <div className="flex items-center gap-2">
      <DetailsPopover label={trigger}>
        <div className="max-h-[70vh] w-[420px] space-y-3 overflow-y-auto p-1 text-xs">
          {showGroupRow && (
            <FilterSection title="Источник (single)">
              <Chip
                active={groupFilter === "all"}
                onClick={() => setGroupFilter("all")}
                label="Все"
              />
              {visibleGroups.map((g) => (
                <Chip
                  key={g}
                  active={groupFilter === g}
                  onClick={() => setGroupFilter(g)}
                  label={CHAIN_GROUP_LABEL[g]}
                  count={groupCounts[g]}
                />
              ))}
            </FilterSection>
          )}
          {showWalletRow && visibleWallets.length > 0 && (
            <FilterSection
              title={`Кошелёк${walletFilter.size > 0 ? ` (${walletFilter.size})` : ""}`}
              onClear={walletFilter.size > 0 ? clearWallets : undefined}
            >
              {visibleWallets.map((l) => (
                <Chip
                  key={l.wallet.id}
                  active={walletFilter.has(l.wallet.id)}
                  onClick={() => toggleWallet(l.wallet.id)}
                  label={l.wallet.name}
                  chain={l.wallet.chain}
                />
              ))}
            </FilterSection>
          )}
          <FilterSection
            title={`Тип позиции${kindFilter.size > 0 ? ` (${kindFilter.size})` : ""}`}
            onClear={kindFilter.size > 0 ? clearKinds : undefined}
          >
            {(["lending", "lp", "staking", "perp", "other"] as const).map((k) => (
              <Chip
                key={k}
                active={kindFilter.has(k)}
                onClick={() => toggleKind(k)}
                label={KIND_LABEL[k]}
              />
            ))}
          </FilterSection>
          {chainsInUse.length > 1 && (
            <FilterSection
              title={`Сеть${chainFilter.size > 0 ? ` (${chainFilter.size})` : ""}`}
              onClear={chainFilter.size > 0 ? clearChains : undefined}
            >
              {chainsInUse.map(([chain, count]) => (
                <Chip
                  key={chain}
                  active={chainFilter.has(chain)}
                  onClick={() => toggleChain(chain)}
                  label={chain}
                  count={count}
                />
              ))}
            </FilterSection>
          )}
          {protocolsInUse.length > 1 && (
            <FilterSection
              title={`Протокол${protocolFilter.size > 0 ? ` (${protocolFilter.size})` : ""}`}
              onClear={protocolFilter.size > 0 ? clearProtocols : undefined}
            >
              {protocolsInUse.map((p) => (
                <Chip
                  key={p.id}
                  active={protocolFilter.has(p.id)}
                  onClick={() => toggleProtocol(p.id)}
                  label={p.name}
                  count={p.count}
                />
              ))}
            </FilterSection>
          )}
          <FilterSection title="PnL">
            <Chip active={filterPnL === "all"} onClick={() => setFilterPnL("all")} label="Все" />
            <Chip active={filterPnL === "profit"} onClick={() => setFilterPnL("profit")} label="Только прибыль" />
            <Chip active={filterPnL === "loss"} onClick={() => setFilterPnL("loss")} label="Только убыток" />
          </FilterSection>
          <FilterSection title="V3 диапазон">
            <Chip active={filterRange === "all"} onClick={() => setFilterRange("all")} label="Все" />
            <Chip active={filterRange === "in"} onClick={() => setFilterRange("in")} label="В диапазоне" />
            <Chip active={filterRange === "out"} onClick={() => setFilterRange("out")} label="Вне диапазона" />
          </FilterSection>
          <FilterSection title="Статусы">
            <Chip
              active={filterHasFee}
              onClick={() => setFilterHasFee(!filterHasFee)}
              label="С pending fee"
            />
            <Chip
              active={filterHasDebt}
              onClick={() => setFilterHasDebt(!filterHasDebt)}
              label="С долгом"
            />
          </FilterSection>
          {activeCount > 0 && (
            <div className="sticky bottom-0 flex justify-end border-t border-border bg-card pt-2">
              <button
                type="button"
                onClick={resetAll}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="h-3 w-3" />
                Сбросить все ({activeCount})
              </button>
            </div>
          )}
        </div>
      </DetailsPopover>
    </div>
  );
}

function FilterSection({
  title,
  children,
  onClear,
}: {
  title: string;
  children: React.ReactNode;
  /** PR #5: per-section clear button (multi-select Sets). */
  onClear?: () => void;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
        {onClear && (
          <button
            type="button"
            onClick={onClear}
            className="rounded px-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Очистить эту секцию"
          >
            ✕
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}
