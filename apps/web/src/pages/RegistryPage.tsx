/**
 * Реестр операций — минимальная версия (v2 «начнём с начала»).
 *
 * Функциональность:
 *   1. Подключение/удаление кошельков (EVM + Solana)
 *   2. Синхронизация on-chain истории (с кэшем)
 *   3. Один плоский хронологический список «сырых» операций со всех
 *      загруженных кошельков. Никаких портфельных аналитик, журнала
 *      учёта или DeFi-позиций — это будет добавлено отдельно после
 *      того, как мы убедимся, что raw-данные корректны.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Filter,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  ShieldCheck,
  Trash2,
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { CURRENT_CACHE_VERSION } from "@/lib/cache";
import { isLikelyEvmAddress } from "@/lib/debank";
import { isLikelySolanaAddress } from "@/lib/helius";
import {
  COINSTATS_CHAIN_GROUPS,
  coinStatsChainLabel,
} from "@/lib/coinstats_chains";
import type { ClassifiedOp } from "@/lib/portfolio/types";
import { looksLikeSpam } from "@/lib/portfolio/spl_tokens";
import { tokenFamily } from "@/lib/portfolio/protocols";
import { useLoadedListWithBridges } from "@/lib/portfolio/use_bridge_detection";
import {
  useLoadedWallets,
  type Loaded,
} from "@/components/data/LoadedWalletsProvider";
import { useIntegrations } from "@/lib/integrations";
import {
  useWallets,
  type SavedWallet,
  type WalletChain,
} from "@/lib/wallets";
import { computeLpCloseAttribution } from "@/lib/portfolio/cost_basis_tracker";
import { useT, useI18n } from "@/i18n/I18nProvider";
import {
  formatDateTime,
  formatNumber,
  formatUsd,
  shortAddress,
} from "@/i18n/format";
import { cn } from "@/lib/utils";
import { Chip } from "@/components/ui/Chip";
import { ManualAnnotationCell } from "@/components/portfolio/ManualAnnotationCell";
import { BulkFiatMarker } from "@/components/portfolio/BulkFiatMarker";
import {
  annotationKey,
  useOpAnnotations,
} from "@/lib/portfolio/manual_annotations";
import { Banknote, Landmark, Tag } from "lucide-react";

type AnnotationFilter = "all" | "any" | "fiat" | "credit" | "none";
import {
  CHAIN_GROUP_LABEL,
  chainGroupOfWallet,
  type ChainGroup,
} from "@/lib/chain_groups";

/* --------------------------- explorer helpers ----------------------------- */

const EVM_EXPLORERS: Record<string, (h: string) => string> = {
  eth: (h) => `https://etherscan.io/tx/${h}`,
  arb: (h) => `https://arbiscan.io/tx/${h}`,
  op: (h) => `https://optimistic.etherscan.io/tx/${h}`,
  matic: (h) => `https://polygonscan.com/tx/${h}`,
  bsc: (h) => `https://bscscan.com/tx/${h}`,
  base: (h) => `https://basescan.org/tx/${h}`,
  avax: (h) => `https://snowtrace.io/tx/${h}`,
  ftm: (h) => `https://ftmscan.com/tx/${h}`,
};

function explorerUrl(op: ClassifiedOp): string {
  if (op.chain === "sol") return `https://solscan.io/tx/${op.hash}`;
  return EVM_EXPLORERS[op.chain]?.(op.hash) ?? `https://debank.com/profile/${op.hash}`;
}

/* =================================== PAGE ================================= */

export function RegistryPage(): JSX.Element {
  const t = useT();
  const { locale } = useI18n();
  const [integrations] = useIntegrations();
  const debankKey = integrations.debankAccessKey.trim();
  const heliusKey = integrations.heliusApiKey.trim();
  const coinstatsKey = (integrations.coinstatsApiKey ?? "").trim();

  const wallets = useWallets();
  const selected = wallets.selected;

  const {
    loadedById,
    busyId,
    progress,
    error,
    load,
    cancel,
    internalHashes,
  } = useLoadedWallets();

  const [formOpen, setFormOpen] = useState<boolean>(wallets.list.length === 0);
  useEffect(() => {
    if (wallets.list.length === 0) setFormOpen(true);
  }, [wallets.list.length]);

  const [filter, setFilter] = useState<string>("");
  const [hideSpam, setHideSpam] = useState<boolean>(true);
  // Multi-select фильтры: Set<value>. Пустой Set = «все».
  const [groupFilter, setGroupFilter] = useState<Set<ChainGroup>>(new Set());
  const [walletFilter, setWalletFilter] = useState<Set<string>>(new Set());
  const [annotationFilter, setAnnotationFilter] = useState<Set<AnnotationFilter>>(
    new Set(),
  );
  const [typeFilter, setTypeFilter] = useState<Set<string>>(new Set());
  const [protocolFilter, setProtocolFilter] = useState<Set<string>>(new Set());
  const [chainFilter, setChainFilter] = useState<Set<string>>(new Set());
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [filtersOpen, setFiltersOpen] = useState<boolean>(false);
  const [annotations] = useOpAnnotations();

  // Toggle helper для Set-фильтров.
  function toggleSet<T>(setter: React.Dispatch<React.SetStateAction<Set<T>>>, v: T) {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  }

  function keyFor(chain: WalletChain): string {
    if (chain === "sol") return heliusKey;
    if (chain === "coinstats") return coinstatsKey;
    return debankKey;
  }

  // Авто-загрузка для выбранного — ТОЛЬКО если кэша нет.
  useEffect(() => {
    if (!selected) return;
    if (loadedById[selected.id]) return;
    if (!keyFor(selected.chain)) return;
    void load(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, debankKey, heliusKey]);

  /* ----------------------- raw ops: чисто хронологически ------------------ */

  const loadedListRaw = useMemo(
    () => Object.values(loadedById).sort((a, b) => a.loadedAt - b.loadedAt),
    [loadedById],
  );
  // Авто-определение bridge: пары `transfer_out` ↔ `transfer_in` между
  // нашими кошельками с одинаковым семейством токена и близкой суммой
  // переклассифицируются как `bridge_out` / `bridge_in`.
  const loadedList = useLoadedListWithBridges(loadedListRaw);

  const allOps = useMemo<ClassifiedOpWithWallet[]>(() => {
    const arr: ClassifiedOpWithWallet[] = [];
    for (const l of loadedList) {
      for (const op of l.ops) arr.push({ ...op, wallet: l.wallet });
    }
    arr.sort((a, b) => b.time - a.time); // самые свежие — сверху
    return arr;
  }, [loadedList]);

  // Атрибуция cost basis от lp_add к lp_remove — по hash. Считаем по каждому
  // кошельку отдельно (позиции не пересекаются между кошельками), потом
  // склеиваем в одну Map<`${walletId}|${hash}`, totalCostUsd>.
  const lpCloseUsdByHash = useMemo(() => {
    const out = new Map<string, number>();
    for (const l of loadedList) {
      const attr = computeLpCloseAttribution(l.ops);
      for (const [hash, perSym] of attr) {
        let sum = 0;
        for (const v of perSym.values()) sum += v.costUsd;
        if (sum > 0) out.set(`${l.wallet.id}|${hash}`, sum);
      }
    }
    return out;
  }, [loadedList]);

  // Кол-во кошельков по группам — для бейджей в чипах источника.
  const groupCounts = useMemo(() => {
    const c: Record<ChainGroup, number> = { evm: 0, sol: 0, coinstats: 0 };
    for (const l of loadedList) c[chainGroupOfWallet(l.wallet)]++;
    return c;
  }, [loadedList]);

  const annotationCounts = useMemo(() => {
    let fiat = 0;
    let credit = 0;
    let any = 0;
    for (const o of allOps) {
      const k = annotationKey({
        walletId: o.wallet.id,
        chain: o.chain,
        hash: o.hash,
      });
      const a = annotations[k];
      if (!a) continue;
      const f = !!a.fiatPurchase;
      const c = !!a.credit;
      if (f) fiat++;
      if (c) credit++;
      if (f || c) any++;
    }
    return { fiat, credit, any };
  }, [allOps, annotations]);

  // Списки уникальных значений для select-фильтров.
  const availableTypes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const o of allOps) counts.set(o.type, (counts.get(o.type) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [allOps]);
  const availableProtocols = useMemo(() => {
    const counts = new Map<string, number>();
    for (const o of allOps) {
      if (!o.protocol?.name) continue;
      counts.set(o.protocol.name, (counts.get(o.protocol.name) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [allOps]);
  const availableChains = useMemo(() => {
    const counts = new Map<string, number>();
    for (const o of allOps) counts.set(o.chain, (counts.get(o.chain) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [allOps]);

  const fromTs = dateFrom ? new Date(dateFrom).getTime() / 1000 : null;
  const toTs = dateTo ? new Date(dateTo).getTime() / 1000 + 86_400 : null;

  const filteredOps = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return allOps.filter((o) => {
      // Multi-select: пустой Set = «все», иначе требуем member-ship.
      if (groupFilter.size > 0 && !groupFilter.has(chainGroupOfWallet(o.wallet)))
        return false;
      if (walletFilter.size > 0 && !walletFilter.has(o.wallet.id)) return false;
      if (typeFilter.size > 0 && !typeFilter.has(o.type)) return false;
      if (
        protocolFilter.size > 0 &&
        (!o.protocol?.name || !protocolFilter.has(o.protocol.name))
      )
        return false;
      if (chainFilter.size > 0 && !chainFilter.has(o.chain)) return false;
      if (fromTs != null && o.time < fromTs) return false;
      if (toTs != null && o.time > toTs) return false;
      // Метки: множественный выбор. Любой матч проходит (OR).
      if (annotationFilter.size > 0) {
        const k = annotationKey({
          walletId: o.wallet.id,
          chain: o.chain,
          hash: o.hash,
        });
        const a = annotations[k];
        const hasFiat = !!a?.fiatPurchase;
        const hasCredit = !!a?.credit;
        const matches = (() => {
          for (const v of annotationFilter) {
            if (v === "any" && (hasFiat || hasCredit)) return true;
            if (v === "fiat" && hasFiat) return true;
            if (v === "credit" && hasCredit) return true;
            if (v === "none" && !(hasFiat || hasCredit)) return true;
          }
          return false;
        })();
        if (!matches) return false;
      }
      // 1) Спам-фильтр
      if (hideSpam) {
        // Approve без движения и без spender'а (либо вообще без token_approve)
        // = бесполезный шум: ни сумм, ни кому approve.
        if (o.type === "approve" && o.movement.length === 0) return false;

        // Если есть движение, проверяем «весь мусор»:
        if (o.movement.length > 0) {
          // Все движения — пыль (нулевые / lamport-уровня / < $0.01).
          // Helius шлёт «маркеры tx» как 1e-9 SOL — это не реальные переводы.
          const DUST_AMOUNT = 1e-6;
          const DUST_USD = 0.01;
          const allDust = o.movement.every(
            (m) =>
              !m.amount ||
              m.amount < DUST_AMOUNT ||
              (m.usd != null && m.usd < DUST_USD),
          );
          if (allDust) return false;

          // Все токены — спам.
          const allSpam = o.movement.every((m) =>
            looksLikeSpam(m.symbol, o.protocol?.name ?? undefined),
          );
          if (allSpam) return false;
        }
      }

      // 2) Текстовый поиск
      if (!q) return true;
      if (o.hash.toLowerCase().includes(q)) return true;
      if (o.chain.toLowerCase().includes(q)) return true;
      if (o.protocol?.name.toLowerCase().includes(q)) return true;
      if (o.counterparty?.toLowerCase().includes(q)) return true;
      // Поиск по символу токена + по нормализованному «семейству»:
      // запрос `usdt` найдёт `USD₮0`, `USDC.e` найдётся по `usdc`.
      if (o.movement.some((m) => {
        const sym = m.symbol.toLowerCase();
        if (sym.includes(q)) return true;
        const fam = tokenFamily(m.symbol).toLowerCase();
        return fam.includes(q);
      })) return true;
      if (o.type.toLowerCase().includes(q)) return true;
      if (o.wallet.name.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [filter, allOps, hideSpam, groupFilter, walletFilter, annotationFilter, annotations, typeFilter, protocolFilter, chainFilter, fromTs, toTs]);

  /* --------------------------------- UI ----------------------------------- */

  const anyLoaded = loadedList.length > 0;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("registry.title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("registry.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          {selected && !busyId && loadedById[selected.id] && (
            <Button onClick={() => void load(selected)}>
              <RefreshCw />
              {t("registry.reload")}
            </Button>
          )}
          {busyId && (
            <Button variant="secondary" onClick={cancel}>
              <X />
              {t("common.cancel")}
            </Button>
          )}
          {/* Очистка локального кэша wallet'ов — на случай странных цифр
              после апдейта формул, недоехавшей синхронизации, изменения
              классификатора. Та же логика что в Настройках → Кэш данных,
              но доступна прямо из реестра без перехода. */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (
                !window.confirm(
                  "Удалить локальный кэш кошельков и перезагрузить страницу?\n\n" +
                    "Сохраняются: API-ключи, профиль, аннотации операций, " +
                    "ручные оверрайды (Стартовый капитал, currentValueUsd, " +
                    "fees, кредитные метки), состав активов.\n\n" +
                    "После перезагрузки нажмите «Обновить» в Cap Wallet — " +
                    "данные подтянутся заново через DeBank/Helius.",
                )
              )
                return;
              let removed = 0;
              for (let i = localStorage.length - 1; i >= 0; i--) {
                const k = localStorage.key(i);
                if (k && k.startsWith("capflow.wallet_cache.")) {
                  localStorage.removeItem(k);
                  removed += 1;
                }
              }
              setTimeout(() => {
                console.info(`Cleared ${removed} wallet cache entries`);
                window.location.reload();
              }, 150);
            }}
            title="Очистить локальный кэш кошельков и перезагрузить"
          >
            <Trash2 />
            Очистить кэш
          </Button>
        </div>
      </header>

      <WalletList
        wallets={wallets}
        loadedById={loadedById}
        formOpen={formOpen}
        onToggleForm={() => setFormOpen((v) => !v)}
        debankKeyOk={Boolean(debankKey)}
        heliusKeyOk={Boolean(heliusKey)}
      />

      {anyLoaded && <CacheFreshness />}

      {error && (
        <Card>
          <CardContent className="py-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}
      {busyId && (
        <Card>
          <CardContent className="py-4 inline-flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("common.loading")} · {progress?.loaded ?? 0} ops · {progress?.pages ?? 0} pages
          </CardContent>
        </Card>
      )}

      {anyLoaded && (
        <>
          {/* Кнопка-toggle для раскрытия панели фильтров */}
          {(() => {
            const activeCount =
              (dateFrom ? 1 : 0) +
              (dateTo ? 1 : 0) +
              walletFilter.size +
              chainFilter.size +
              groupFilter.size +
              typeFilter.size +
              protocolFilter.size +
              annotationFilter.size;
            return (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setFiltersOpen((v) => !v)}
                  className={cn(
                    "inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-all",
                    activeCount > 0 || filtersOpen
                      ? "border-brand-cyan/60 bg-brand-cyan/10 text-brand-cyan"
                      : "border-border bg-secondary/50 text-muted-foreground hover:border-brand-cyan/40 hover:text-foreground",
                  )}
                >
                  <Filter className="h-4 w-4" />
                  Фильтры
                  {activeCount > 0 && (
                    <span className="rounded-full bg-brand-cyan/20 px-1.5 py-px text-[10px] font-bold text-brand-cyan">
                      {activeCount}
                    </span>
                  )}
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 transition-transform duration-200",
                      filtersOpen && "rotate-180",
                    )}
                  />
                </button>
                {activeCount > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setDateFrom("");
                      setDateTo("");
                      setChainFilter(new Set());
                      setTypeFilter(new Set());
                      setProtocolFilter(new Set());
                      setWalletFilter(new Set());
                      setGroupFilter(new Set());
                      setAnnotationFilter(new Set());
                    }}
                    className="inline-flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:border-destructive/40 hover:text-destructive"
                  >
                    <X className="h-3 w-3" /> Сбросить
                  </button>
                )}
              </div>
            );
          })()}

          {/* Единый фильтр со всеми параметрами (multi-select). */}
          <div
            className={cn(
              "grid transition-[grid-template-rows] duration-300 ease-out",
              filtersOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
            )}
          >
            <div className="overflow-hidden">
          <div className="space-y-3 rounded-lg border border-border bg-secondary/30 p-3">
            {/* Daterange */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
                  Дата с
                </label>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="h-9 w-full rounded-md border border-border bg-background px-2 text-xs"
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
                  Дата до
                </label>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="h-9 w-full rounded-md border border-border bg-background px-2 text-xs"
                />
              </div>
            </div>

            {/* Кошельки */}
            {loadedList.length > 1 && (
              <ChipGroup
                label="Кошельки"
                selected={walletFilter}
                onToggle={(v) => toggleSet(setWalletFilter, v)}
                onClear={() => setWalletFilter(new Set())}
                items={loadedList.map((l) => ({
                  value: l.wallet.id,
                  label: l.wallet.name,
                }))}
              />
            )}

            {/* Сети */}
            <ChipGroup
              label="Сети"
              selected={chainFilter}
              onToggle={(v) => toggleSet(setChainFilter, v)}
              onClear={() => setChainFilter(new Set())}
              items={availableChains.map(([c, n]) => ({
                value: c,
                label: c.toUpperCase(),
                count: n,
              }))}
            />

            {/* Источник (chain group) */}
            {Object.values(groupCounts).filter((n) => n > 0).length > 1 && (
              <ChipGroup
                label="Источник"
                selected={groupFilter}
                onToggle={(v) => toggleSet(setGroupFilter, v as ChainGroup)}
                onClear={() => setGroupFilter(new Set())}
                items={(["evm", "sol", "coinstats"] as const)
                  .filter((g) => groupCounts[g] > 0)
                  .map((g) => ({
                    value: g,
                    label: CHAIN_GROUP_LABEL[g],
                    count: groupCounts[g],
                  }))}
              />
            )}

            {/* Типы операций */}
            <ChipGroup
              label="Типы"
              selected={typeFilter}
              onToggle={(v) => toggleSet(setTypeFilter, v)}
              onClear={() => setTypeFilter(new Set())}
              monoLabel
              items={availableTypes.map(([t, n]) => ({
                value: t,
                label: t,
                count: n,
              }))}
            />

            {/* Протоколы */}
            <ChipGroup
              label="Протоколы"
              selected={protocolFilter}
              onToggle={(v) => toggleSet(setProtocolFilter, v)}
              onClear={() => setProtocolFilter(new Set())}
              items={availableProtocols.map(([p, n]) => ({
                value: p,
                label: p,
                count: n,
              }))}
            />

            {/* Метки */}
            <ChipGroup
              label="Метки"
              selected={annotationFilter as Set<string>}
              onToggle={(v) =>
                toggleSet(
                  setAnnotationFilter as React.Dispatch<
                    React.SetStateAction<Set<string>>
                  >,
                  v,
                )
              }
              onClear={() => setAnnotationFilter(new Set())}
              items={[
                {
                  value: "any",
                  label: "С метками",
                  count: annotationCounts.any,
                },
                {
                  value: "fiat",
                  label: "Куплено за фиат",
                  count: annotationCounts.fiat,
                },
                {
                  value: "credit",
                  label: "Кредитный актив",
                  count: annotationCounts.credit,
                },
                { value: "none", label: "Без меток" },
              ]}
            />

            {/* Сброс */}
            {(dateFrom ||
              dateTo ||
              chainFilter.size > 0 ||
              typeFilter.size > 0 ||
              protocolFilter.size > 0 ||
              walletFilter.size > 0 ||
              groupFilter.size > 0 ||
              annotationFilter.size > 0) && (
              <button
                type="button"
                onClick={() => {
                  setDateFrom("");
                  setDateTo("");
                  setChainFilter(new Set());
                  setTypeFilter(new Set());
                  setProtocolFilter(new Set());
                  setWalletFilter(new Set());
                  setGroupFilter(new Set());
                  setAnnotationFilter(new Set());
                }}
                className="inline-flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border px-2 py-1.5 text-[11px] font-medium text-muted-foreground hover:border-brand-cyan/40 hover:text-brand-cyan transition-colors"
              >
                <X className="h-3 w-3" /> Сбросить все фильтры
              </button>
            )}
          </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-1 min-w-[260px] items-center gap-2 rounded-md border border-border bg-secondary px-3 py-2 text-sm text-muted-foreground">
              <Search className="h-4 w-4" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="0xabc… / USDC / Aave / wallet name"
                className="flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/70"
              />
              <Badge variant="muted" className="text-[10px]">
                {filteredOps.length} / {allOps.length}
              </Badge>
            </div>
            <label className="flex items-center gap-2 whitespace-nowrap rounded-md border border-border bg-secondary px-3 py-2 text-xs text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={hideSpam}
                onChange={(e) => setHideSpam(e.target.checked)}
              />
              Скрыть спам и пустые approve
            </label>
            <BulkFiatMarker loadedList={loadedList} />
          </div>

          {filteredOps.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                {t("registry.empty")}
              </CardContent>
            </Card>
          ) : (
            <RawOpsTable
              ops={filteredOps}
              locale={locale}
              lpCloseUsdByHash={lpCloseUsdByHash}
              internalHashes={internalHashes}
            />
          )}
        </>
      )}
    </div>
  );
}

interface ChipItem {
  value: string;
  label: string;
  count?: number;
}

function ChipGroup({
  label,
  items,
  selected,
  onToggle,
  onClear,
  monoLabel,
}: {
  label: string;
  items: ChipItem[];
  selected: Set<string>;
  onToggle: (v: string) => void;
  onClear: () => void;
  monoLabel?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
          {selected.size > 0 && (
            <span className="ml-1 rounded-full bg-brand-cyan/15 px-1.5 py-px text-[9px] font-bold text-brand-cyan">
              {selected.size}
            </span>
          )}
        </span>
        {selected.size > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="text-[10px] text-muted-foreground hover:text-foreground"
          >
            сбросить
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((it) => {
          const active = selected.has(it.value);
          return (
            <button
              key={it.value}
              type="button"
              onClick={() => onToggle(it.value)}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] transition-all",
                active
                  ? "border-brand-cyan/60 bg-brand-cyan/15 text-brand-cyan"
                  : "border-border bg-secondary/50 text-muted-foreground hover:border-brand-cyan/30 hover:text-foreground",
                monoLabel && "font-mono",
              )}
            >
              <span className="font-medium">{it.label}</span>
              {it.count != null && (
                <span className={cn("text-[10px]", active ? "opacity-90" : "opacity-70")}>
                  ({it.count})
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AnnotationChip({
  active,
  onClick,
  label,
  count,
  icon,
  accent,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  icon?: React.ReactNode;
  accent?: "emerald" | "warning" | "brand";
}) {
  const accentActive =
    accent === "emerald"
      ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-400"
      : accent === "warning"
        ? "border-warning/60 bg-warning/15 text-warning"
        : "border-brand-cyan/60 bg-brand-cyan/15 text-brand-cyan";
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-all duration-200 hover:scale-[1.03]",
        active
          ? accentActive
          : "border-border bg-secondary text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {label}
      {count != null && (
        <span className="text-[10px] opacity-70">({count})</span>
      )}
    </button>
  );
}

/* ============================ Raw operations list ========================= */

interface ClassifiedOpWithWallet extends ClassifiedOp {
  wallet: SavedWallet;
}

function RawOpsTable({
  ops,
  locale,
  lpCloseUsdByHash,
  internalHashes,
}: {
  ops: ClassifiedOpWithWallet[];
  locale: "en" | "ru";
  lpCloseUsdByHash: Map<string, number>;
  internalHashes: Set<string>;
}) {
  return (
    <Card>
      <CardContent className="px-0 pb-0">
        <div className="overflow-x-auto">
          <table className="w-full text-xs" style={{ minWidth: 1200 }}>
            <thead className="border-y border-border bg-secondary/40 text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium w-32">Дата / время</th>
                <th className="px-3 py-2 text-left font-medium w-32">Кошелёк</th>
                <th className="px-3 py-2 text-left font-medium w-20">Сеть</th>
                <th className="px-3 py-2 text-left font-medium w-32">Тип (auto)</th>
                <th className="px-3 py-2 text-left font-medium">Движение</th>
                <th className="px-3 py-2 text-left font-medium w-44">Контрагент / протокол</th>
                <th className="px-3 py-2 text-right font-medium w-24">Газ USD</th>
                <th className="px-3 py-2 text-right font-medium w-28">Tx</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {ops.map((op) => (
                <tr key={op.wallet.id + op.chain + op.hash} className="hover:bg-accent/40">
                  <td className="px-3 py-2 text-muted-foreground tabular-nums whitespace-nowrap text-xs">
                    {formatDateTime(op.time)}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded border border-border bg-secondary px-1.5 py-0.5 text-[10px]",
                        op.wallet.chain === "sol" ? "text-[#14F195]" : "text-brand-cyan",
                      )}
                    >
                      <Wallet className="h-3 w-3" />
                      {op.wallet.name}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant="outline" className="uppercase text-[10px]">
                      {op.chain}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {op.type}
                    </span>
                    {op.status === "failed" && (
                      <span className="ml-1 text-[10px] uppercase tracking-wider text-destructive">
                        · failed
                      </span>
                    )}
                    {internalHashes.has(op.hash) && (
                      <span
                        className="ml-1 inline-block rounded border border-brand-cyan/40 bg-brand-cyan/10 px-1 py-0.5 text-[9px] uppercase tracking-wider text-brand-cyan"
                        title="Перевод между двумя своими кошельками — cost basis наследуется, не считается продажей/покупкой."
                      >
                        ↔ internal
                      </span>
                    )}
                    {op.type === "lp_remove" &&
                      lpCloseUsdByHash.get(`${op.wallet.id}|${op.hash}`) != null && (
                        <div
                          className="mt-0.5 inline-block rounded border border-blue-500/40 bg-blue-500/10 px-1 py-0.5 text-[9px] text-blue-400"
                          title="Cost basis from LP deposit, attributed to this close"
                        >
                          cost basis +{formatUsd(
                            lpCloseUsdByHash.get(
                              `${op.wallet.id}|${op.hash}`,
                            )!,
                            locale,
                          )}
                        </div>
                      )}
                  </td>
                  <td className="px-3 py-2">
                    <Movements op={op} locale={locale} />
                    {(() => {
                      // Главный токен для расчёта курса — первое входящее
                      // движение. Если нет (например swap-out), показываем
                      // только пометку Кредит без числа курса.
                      const inMv = op.movement.find(
                        (m) => m.direction === "in" && m.amount > 0,
                      );
                      return (
                        <ManualAnnotationCell
                          walletId={op.wallet.id}
                          chain={op.chain}
                          hash={op.hash}
                          {...(inMv && {
                            primaryToken: {
                              symbol: inMv.symbol,
                              amount: inMv.amount,
                            },
                          })}
                        />
                      );
                    })()}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {op.protocol ? (
                      <span className="inline-flex items-center gap-1">
                        <span className="font-medium text-foreground">{op.protocol.name}</span>
                        {op.detection === "auto" && (
                          <span
                            title="Тип определён эвристикой по нетто-балансам — протокол не зарегистрирован в нашем реестре. Стоит верифицировать."
                            className="rounded border border-amber-500/40 bg-amber-500/10 px-1 text-[9px] font-bold uppercase text-amber-500"
                          >
                            auto
                          </span>
                        )}
                      </span>
                    ) : op.counterparty ? (
                      <span className="font-mono text-[10px]">
                        {shortAddress(op.counterparty, 6, 4)}
                      </span>
                    ) : op.fnName ? (
                      <span className="font-mono text-[10px]">{op.fnName}</span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground whitespace-nowrap">
                    {op.gasUsd != null && op.gasUsd > 0 ? formatUsd(op.gasUsd, locale) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <a
                      href={explorerUrl(op)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 font-mono text-[10px] text-brand-cyan hover:underline"
                    >
                      {shortAddress(op.hash, 6, 4)}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function Movements({
  op,
  locale,
}: {
  op: ClassifiedOp;
  locale: "en" | "ru";
}) {
  const sends = op.movement.filter((m) => m.direction === "out");
  const receives = op.movement.filter((m) => m.direction === "in");
  if (sends.length === 0 && receives.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <div className="flex flex-col gap-0.5 text-[11px]">
      {sends.map((s, i) => (
        <span key={`s-${i}`} className="text-destructive">
          − {formatNumber(s.amount, locale, 6)} {s.symbol}
          {s.usd != null && s.usd > 0 && (
            <span className="ml-1 text-[10px] text-muted-foreground">
              ({formatUsd(s.usd, locale)})
            </span>
          )}
        </span>
      ))}
      {receives.map((r, i) => (
        <span key={`r-${i}`} className="text-success">
          + {formatNumber(r.amount, locale, 6)} {r.symbol}
          {r.usd != null && r.usd > 0 && (
            <span className="ml-1 text-[10px] text-muted-foreground">
              ({formatUsd(r.usd, locale)})
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

/* ============================ Wallet list block =========================== */

function WalletList({
  wallets,
  loadedById,
  formOpen,
  onToggleForm,
  debankKeyOk,
  heliusKeyOk,
}: {
  wallets: ReturnType<typeof useWallets>;
  loadedById: Record<string, Loaded>;
  formOpen: boolean;
  onToggleForm: () => void;
  debankKeyOk: boolean;
  heliusKeyOk: boolean;
}) {
  const t = useT();
  const { forget } = useLoadedWallets();
  const hasWallets = wallets.list.length > 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-brand-cyan" />
            {t("registry.wallets.title")}
          </CardTitle>
          <CardDescription>
            <span className="flex flex-wrap items-center gap-3">
              <KeyStatus ok={debankKeyOk} label="DeBank" />
              <KeyStatus ok={heliusKeyOk} label="Helius" />
            </span>
          </CardDescription>
        </div>
        <Button
          variant={formOpen ? "ghost" : "outline"}
          size="sm"
          onClick={onToggleForm}
          aria-expanded={formOpen}
        >
          {formOpen ? (
            <>
              <ChevronDown className="rotate-180 transition-transform" />
              {t("registry.wallets.collapse")}
            </>
          ) : (
            <>
              <Plus />
              {hasWallets
                ? t("registry.wallets.addAnother")
                : t("registry.wallets.add")}
            </>
          )}
        </Button>
      </CardHeader>

      <CardContent className="space-y-4">
        {hasWallets ? (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {wallets.list.map((w) => (
              <WalletCard
                key={w.id}
                wallet={w}
                active={wallets.selectedId === w.id}
                loaded={Boolean(loadedById[w.id])}
                onSelect={() => wallets.select(w.id)}
                onRename={(name) => wallets.update(w.id, { name })}
                onDelete={() => {
                  wallets.remove(w.id);
                  forget(w.id);
                }}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t("registry.wallets.empty")}</p>
        )}

        <div
          className={cn(
            "grid transition-[grid-template-rows] duration-200 ease-out",
            formOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
        >
          <div className="overflow-hidden">
            {formOpen && (
              <AddWalletForm
                existing={wallets.list}
                onAdd={(input) => {
                  wallets.add(input);
                  onToggleForm();
                }}
              />
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function KeyStatus({ ok, label }: { ok: boolean; label: string }) {
  return ok ? (
    <span className="inline-flex items-center gap-1 text-success">
      <ShieldCheck className="h-3.5 w-3.5" /> {label}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <X className="h-3.5 w-3.5" /> {label}
    </span>
  );
}

function WalletCard({
  wallet,
  active,
  loaded,
  onSelect,
  onRename,
  onDelete,
}: {
  wallet: SavedWallet;
  active: boolean;
  loaded: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(wallet.name);
  const [copied, setCopied] = useState(false);

  function handleSave() {
    const v = draft.trim();
    if (v) onRename(v);
    setEditing(false);
  }
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* noop */
    }
  }
  function handleDelete() {
    if (window.confirm(t("registry.wallets.confirmDelete"))) onDelete();
  }

  const chainLabel =
    wallet.chain === "sol"
      ? "Solana"
      : wallet.chain === "coinstats"
        ? wallet.connectionId
          ? coinStatsChainLabel(wallet.connectionId)
          : "CoinStats"
        : "EVM";

  return (
    <li
      className={cn(
        "group relative rounded-lg border bg-card/60 p-4 transition-colors",
        active
          ? "border-brand-cyan/60 ring-1 ring-brand-cyan/40"
          : "border-border hover:bg-accent/40",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="absolute inset-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t("registry.wallets.select")}
      />
      <div className="relative flex items-start gap-3">
        <div
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-md text-background shrink-0",
            wallet.chain === "sol"
              ? "bg-gradient-to-br from-[#9945FF] to-[#14F195]"
              : "bg-brand-gradient",
          )}
        >
          <Wallet className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          {editing ? (
            <Input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={handleSave}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSave();
                if (e.key === "Escape") {
                  setDraft(wallet.name);
                  setEditing(false);
                }
              }}
              className="relative h-8 text-sm"
            />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-sm font-semibold">{wallet.name}</h3>
              {active && (
                <Badge variant="default" className="h-5 px-2 text-[10px]">
                  {t("registry.wallets.selected")}
                </Badge>
              )}
              {loaded && (
                <Badge variant="success" className="h-5 px-2 text-[10px]">
                  ✓
                </Badge>
              )}
            </div>
          )}
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
            {shortAddress(wallet.address, 8, 6)}
          </p>
          <p className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            {chainLabel}
          </p>
        </div>
      </div>

      <div className="relative mt-3 flex items-center justify-end gap-1">
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={handleCopy} aria-label={t("registry.wallets.copyAddress")} title={t("registry.wallets.copyAddress")}>
          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8"
          onClick={() => { setDraft(wallet.name); setEditing(true); }}
          aria-label={t("registry.wallets.edit")} title={t("registry.wallets.edit")}>
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive"
          onClick={handleDelete} aria-label={t("registry.wallets.delete")} title={t("registry.wallets.delete")}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </li>
  );
}

function AddWalletForm({
  existing,
  onAdd,
}: {
  existing: SavedWallet[];
  onAdd: (input: {
    name: string;
    address: string;
    chain: WalletChain;
    connectionId?: string;
  }) => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  // Значение селектора: "evm" / "sol" / CoinStats `connectionId`.
  const [chainSelect, setChainSelect] = useState<string>("evm");
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);

  const isEvm = chainSelect === "evm";
  const isSol = chainSelect === "sol";
  const isCoinstats = !isEvm && !isSol;

  // Базовая валидация адреса. Для CoinStats просто проверяем что не пусто
  // и >= 20 символов (Bitcoin/TON/Cardano и т.д. имеют разные форматы).
  const validAddress = isEvm
    ? isLikelyEvmAddress(address)
    : isSol
      ? isLikelySolanaAddress(address)
      : address.trim().length >= 20;
  const trimmed = address.trim().toLowerCase();
  const duplicate = existing.some((w) => w.address.toLowerCase() === trimmed);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!validAddress) {
      setError(
        isEvm
          ? t("registry.invalidAddress")
          : isSol
            ? t("registry.invalidSolanaAddress")
            : "Слишком короткий адрес",
      );
      return;
    }
    if (duplicate) {
      setError(t("registry.duplicate"));
      return;
    }
    const baseName = name.trim() || `Wallet ${existing.length + 1}`;
    if (isCoinstats) {
      onAdd({
        name: baseName,
        address,
        chain: "coinstats",
        connectionId: chainSelect,
      });
    } else {
      onAdd({
        name: baseName,
        address,
        chain: isEvm ? "evm" : "sol",
      });
    }
    setName("");
    setAddress("");
  }

  return (
    <form onSubmit={submit}
      className="mt-2 grid grid-cols-1 gap-3 rounded-md border border-border bg-secondary/40 p-4 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor="w-name">{t("registry.form.name")}</Label>
        <Input id="w-name" value={name} onChange={(e) => setName(e.target.value)}
          placeholder={t("registry.form.name.placeholder")} autoComplete="off" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="w-chain">{t("registry.form.chain")}</Label>
        <select
          id="w-chain"
          value={chainSelect}
          onChange={(e) => setChainSelect(e.target.value)}
          className="flex h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground"
        >
          {/* Beta scope: EVM only. Solana (Helius) and CoinStats chains
              are hidden until their data pipelines are production-ready. */}
          <option value="evm">{t("registry.form.chain.evm")}</option>
        </select>
      </div>
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="w-addr">{t("registry.address.label")}</Label>
        <Input
          id="w-addr"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder={
            isEvm
              ? "0x…"
              : isSol
                ? "Solana base58 address"
                : "Адрес кошелька в выбранной сети"
          }
          spellCheck={false}
          autoComplete="off"
          className="font-mono"
        />
      </div>
      <div className="flex items-center justify-end gap-2 sm:col-span-2">
        {error && <p className="mr-auto text-xs text-destructive">{error}</p>}
        <Button type="submit" disabled={!validAddress || duplicate || name.trim().length === 0}>
          <Plus />{t("registry.form.save")}
        </Button>
      </div>
    </form>
  );
}

/* ----------------------- Cache freshness panel --------------------------- */

function CacheFreshness() {
  const t = useT();
  const { locale } = useI18n();
  const { loadedById, busyId, loadAll, forgetAll } = useLoadedWallets();
  const wallets = useWallets();

  const loaded = Object.values(loadedById);
  if (loaded.length === 0) return null;

  const oldestLoadedAt = Math.min(...loaded.map((l) => l.loadedAt));
  const ageMs = Date.now() - oldestLoadedAt;
  const ageHours = ageMs / 3_600_000;

  const ageLabel =
    ageHours < 1
      ? `${Math.max(1, Math.round(ageMs / 60_000))} ${locale === "ru" ? "мин" : "min"}`
      : ageHours < 24
      ? `${Math.round(ageHours)} ${locale === "ru" ? "ч" : "h"}`
      : `${Math.round(ageHours / 24)} ${locale === "ru" ? "д" : "d"}`;

  const stale = ageHours > 1;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-secondary/40 px-4 py-2 text-xs text-muted-foreground">
      <div>
        <span className={stale ? "text-warning" : "text-success"}>●</span>{" "}
        {t("registry.cache.updated")} <span className="font-medium text-foreground">{ageLabel}</span> {t("registry.cache.ago")} ·{" "}
        {loaded.length}/{wallets.list.length} {t("registry.cache.wallets")} ·{" "}
        <span className="font-mono text-[10px]">cache v{CURRENT_CACHE_VERSION}</span>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={Boolean(busyId)}
          onClick={() => void loadAll()}
          title={t("registry.cache.incrementalHint")}
        >
          <RotateCw className="h-3.5 w-3.5" />
          {t("registry.cache.refresh")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={Boolean(busyId)}
          onClick={() => {
            if (window.confirm(t("registry.cache.confirmFull")))
              void loadAll({ full: true });
          }}
          title={t("registry.cache.fullHint")}
        >
          <RotateCw className="h-3.5 w-3.5" />
          {t("registry.cache.fullRefresh")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (window.confirm(t("registry.cache.confirmClear"))) forgetAll();
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t("registry.cache.clear")}
        </Button>
      </div>
    </div>
  );
}
