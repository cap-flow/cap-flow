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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
import { isJunkOp } from "@/lib/portfolio/junk_filter";
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
import { useActiveAccount } from "@/features/accounts/hooks";
import {
  useCexAccounts,
  useCexTransfersWithHash,
  useCexWithdrawalCostBasis,
  useSyncAllCex,
} from "@/features/cex/hooks";
import { walletsApi, type AddressType } from "@/features/wallets/api";
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
import { CexExchangesPanel } from "@/components/cex/CexExchangesPanel";
import {
  annotationKey,
  useOpAnnotations,
} from "@/lib/portfolio/manual_annotations";
import { useAnnotations } from "@/features/chain-ops/hooks";
import { OpAnnotationDialog } from "@/components/data/OpAnnotationDialog";
import { useAuth } from "@/features/auth/AuthProvider";
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
  // Wires this page's add/remove through the SaaS API. Without this
  // RegistryPage talked only to localStorage — wallets stayed
  // device-local and admin/portfolios couldn't see them.
  const registrySync = useRegistryApiSync(wallets);

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

  /**
   * UX «кошелёк подключается» — единая видимая карточка статуса от
   * submit'а формы до окончания первого DeBank/Helius pull'а. До этого
   * фикса пользователи жаловались что «сервис висит» — на самом деле:
   *   1. `registrySync.onAdd` (now invalidates queries) → hydration
   *      refetch → новый кошелёк появляется в `wallets.list`
   *   2. Эффект ниже автоматически делает его `selected`
   *   3. Существующий `useEffect` для auto-load дёргает DeBank
   *   4. Эта карточка с тех пор показывает прогресс (loaded ops, pages)
   *   5. После того как кошелёк попадает в `loadedById` — карточка
   *      исчезает (с лёгкой задержкой чтоб пользователь успел увидеть
   *      «✓ готово»).
   */
  const [pendingAdd, setPendingAdd] = useState<
    | {
        startedAt: number;
        name: string;
        address: string;
        chain: WalletChain;
        /** Заполняется когда API уже вернул walletId — до этого момента
         *  показываем «Сохраняем адрес на сервере…». */
        apiWalletId?: string;
        /** Локальный id (api:<wid>:<aid>) — заполняется когда hydration
         *  привёл новый кошелёк в `wallets.list`. */
        localId?: string;
        /** Финальный статус: операции загружены → показываем «✓ готово»
         *  пару секунд и убираем карточку. */
        done?: boolean;
        /** Текст ошибки если API упал. Карточка показывается красной. */
        error?: string;
      }
    | null
  >(null);

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

  // UCB A3: server-side annotations (override classifier). Bulk-load
  // ВСЕХ annotations user'а, потом строим composite-key map для O(1)
  // lookup в строках таблицы.
  const auth = useAuth();
  const serverAnnotationsQuery = useAnnotations(!!auth.user?.id);
  const serverAnnotationsByKey = useMemo(() => {
    const m = new Map<string, import("@/features/chain-ops/api").ResolvedAnnotation>();
    for (const a of serverAnnotationsQuery.data?.annotations ?? []) {
      m.set(`${a.walletId}|${a.txHash.toLowerCase()}|${a.logIndex}`, a);
    }
    return m;
  }, [serverAnnotationsQuery.data]);

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

  /* ────── pending-add lifecycle ────── */

  // 1) Когда hydration привёл новый кошелёк в список — делаем его
  //    `selected` (иначе авто-загрузка не дёрнется) и сохраняем
  //    локальный id чтобы трекать состояние «загружен / в работе».
  useEffect(() => {
    if (!pendingAdd?.apiWalletId || pendingAdd.localId) return;
    const prefix = `api:${pendingAdd.apiWalletId}:`;
    const fresh = wallets.list.find((w) => w.id.startsWith(prefix));
    if (!fresh) return;
    setPendingAdd((p) => (p ? { ...p, localId: fresh.id } : p));
    if (wallets.selectedId !== fresh.id) {
      wallets.select(fresh.id);
    }
  }, [pendingAdd?.apiWalletId, pendingAdd?.localId, wallets.list, wallets.selectedId, wallets.select]);

  // 2) Как только кошелёк попал в `loadedById` (т.е. DeBank/Helius
  //    отработал) — помечаем done и через 3 секунды убираем карточку.
  useEffect(() => {
    if (!pendingAdd?.localId || pendingAdd.done) return;
    if (!loadedById[pendingAdd.localId]) return;
    if (busyId === pendingAdd.localId) return;
    setPendingAdd((p) => (p ? { ...p, done: true } : p));
    const t = window.setTimeout(() => setPendingAdd(null), 3000);
    return () => window.clearTimeout(t);
  }, [pendingAdd?.localId, pendingAdd?.done, loadedById, busyId]);

  /**
   * Обёртка над `registrySync.onAdd` которая ведёт `pendingAdd`-карточку
   * (immediate feedback) и пробрасывает ошибки наружу — `AddWalletForm`
   * сам решает закрывать форму или нет.
   */
  const handleAddWallet = useCallback(
    async (input: {
      name: string;
      address: string;
      chain: WalletChain;
      connectionId?: string;
    }) => {
      // Сразу показываем «подключаем…» — без задержки. Главный фикс
      // жалобы «после submit'а ничего не происходит».
      setPendingAdd({
        startedAt: Date.now(),
        name: input.name.trim() || input.address,
        address: input.address,
        chain: input.chain,
      });
      try {
        const result = await registrySync.onAdd(input);
        if (result.kind === "api") {
          setPendingAdd((p) =>
            p ? { ...p, apiWalletId: result.apiWalletId } : p,
          );
        } else if (result.kind === "duplicate") {
          // Дубль адреса — просто убираем карточку, ничего страшного.
          setPendingAdd(null);
        } else {
          // Local-only fallback (no primary account). Hydration не будет
          // — сразу пробуем загрузить и убираем карточку.
          setPendingAdd((p) =>
            p ? { ...p, localId: result.wallet.id } : p,
          );
        }
      } catch (e) {
        setPendingAdd((p) =>
          p ? { ...p, error: (e as Error).message ?? "Не удалось подключить" } : p,
        );
      }
    },
    [registrySync],
  );

  /* ----------------------- raw ops: чисто хронологически ------------------ */

  const loadedListRaw = useMemo(
    () => Object.values(loadedById).sort((a, b) => a.loadedAt - b.loadedAt),
    [loadedById],
  );
  // Авто-определение bridge: пары `transfer_out` ↔ `transfer_in` между
  // нашими кошельками с одинаковым семейством токена и близкой суммой
  // переклассифицируются как `bridge_out` / `bridge_in`.
  const loadedList = useLoadedListWithBridges(loadedListRaw);

  // Hash-индекс CEX-переводов: один lookup по tx_hash и мы знаем, что
  // эта on-chain операция парная депозиту/выводу с биржи. Регистр
  // показывает badge "↔ Bitget" вместо обычного "transfer".
  const cexTransfersWithHashQ = useCexTransfersWithHash();
  const cexLinkByHash = useMemo(() => {
    const m = new Map<
      string,
      { exchange: string; label: string | null; direction: "deposit" | "withdrawal" }
    >();
    for (const t of cexTransfersWithHashQ.data ?? []) {
      // Hash equality is case-insensitive on EVM (0x… stored mixed-case
      // by Bitget). Index by lowercased form, lookup the same way.
      m.set(t.txHash.toLowerCase(), {
        exchange: t.exchange,
        label: t.label,
        direction: t.direction as "deposit" | "withdrawal",
      });
    }
    return m;
  }, [cexTransfersWithHashQ.data]);

  // Cost-basis для каждого withdrawal с биржи — позволяет показывать
  // «Стартовый капитал из фиата» бэйдж на on-chain приёмных операциях.
  const costBasisQ = useCexWithdrawalCostBasis();
  const cexCostBasisByHash = useMemo(() => {
    const m = new Map<
      string,
      { costBasisUsd: number; source: string; asset: string }
    >();
    for (const c of costBasisQ.data ?? []) {
      m.set(c.txHash.toLowerCase(), {
        costBasisUsd: c.costBasisUsd,
        source: c.source,
        asset: c.asset,
      });
    }
    return m;
  }, [costBasisQ.data]);

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
        // Провалидированная junk-классификация (та же, что отсекает мусор из
        // cost basis / аналитики через isJunkOp): scam_airdrop, dust,
        // unknown_phantom (получение токена с USD≈$0, который looksLikeSpam
        // по символу не ловит), mev_failure, empty_movement.
        if (isJunkOp(o)) return false;

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

      {/* Заметная карточка статуса подключения. Появляется сразу при
          submit AddWalletForm — пользователь видит что что-то происходит,
          а не молчаливый «зависший» экран. */}
      {pendingAdd && (
        <PendingAddCard
          pending={pendingAdd}
          progress={progress}
          onDismiss={() => setPendingAdd(null)}
        />
      )}

      <WalletList
        wallets={wallets}
        loadedById={loadedById}
        formOpen={formOpen}
        onToggleForm={() => setFormOpen((v) => !v)}
        debankKeyOk={Boolean(debankKey)}
        heliusKeyOk={Boolean(heliusKey)}
        registrySync={registrySync}
        onAddWallet={handleAddWallet}
      />

      <CexExchangesPanel />

      {/* CacheFreshness теперь рендерится и когда есть только CEX
          (без on-chain кошельков) — кнопка «Обновить всё» в нём
          синкает CEX-биржи тоже, поэтому она нужна даже когда
          loadedList пуст. */}
      <CacheFreshness />
      {void anyLoaded}

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
              cexLinkByHash={cexLinkByHash}
              cexCostBasisByHash={cexCostBasisByHash}
              annotationsByKey={serverAnnotationsByKey}
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
  cexLinkByHash,
  cexCostBasisByHash,
  annotationsByKey,
}: {
  ops: ClassifiedOpWithWallet[];
  locale: "en" | "ru";
  lpCloseUsdByHash: Map<string, number>;
  internalHashes: Set<string>;
  cexLinkByHash: Map<
    string,
    { exchange: string; label: string | null; direction: "deposit" | "withdrawal" }
  >;
  cexCostBasisByHash: Map<
    string,
    { costBasisUsd: number; source: string; asset: string }
  >;
  /**
   * UCB A3: map по composite key `${walletId}|${txHash}|${logIndex}` →
   * resolved annotation. Когда пользователь открывает annotation dialog
   * мы pre-fill'им форму current value (если есть) и шлём composite key
   * на upsert.
   */
  annotationsByKey: Map<string, import("@/features/chain-ops/api").ResolvedAnnotation>;
}) {
  // Local state для открытия annotation dialog'а — храним выбранный op.
  const [editingOp, setEditingOp] = useState<ClassifiedOpWithWallet | null>(
    null,
  );

  // Map'инг compositeId → walletId UUID. Composite frontend id —
  // `api:<walletId>:<addressId>`, walletId UUID = средняя часть.
  const realWalletId = useCallback((compositeId: string): string => {
    if (compositeId.startsWith("api:")) {
      const parts = compositeId.split(":");
      return parts[1] ?? compositeId;
    }
    return compositeId;
  }, []);

  return (
    <Card>
      <CardContent className="px-0 pb-0">
        {/* Desktop: таблица */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-xs">
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
                    {(() => {
                      const cex = cexLinkByHash.get(op.hash.toLowerCase());
                      if (!cex) return null;
                      const label = cex.label
                        ? `${cex.exchange}/${cex.label}`
                        : cex.exchange;
                      return (
                        <span
                          className="ml-1 inline-block rounded border border-purple-500/40 bg-purple-500/10 px-1 py-0.5 text-[9px] uppercase tracking-wider text-purple-400"
                          title={`Парная операция с биржей ${label} (${cex.direction === "deposit" ? "вы отправили на CEX" : "пришло с CEX"}). Cost basis сохраняется, не считается продажей/покупкой.`}
                        >
                          ↔ {label}
                        </span>
                      );
                    })()}
                    {(() => {
                      // Cost-basis-from-fiat badge: applies only to
                      // incoming on-chain ops paired with a CEX
                      // WITHDRAWAL (CEX → wallet). The cost basis is
                      // the USD value the user effectively invested in
                      // the chain Fiat → P2P → trade → withdrawal.
                      const cb = cexCostBasisByHash.get(
                        op.hash.toLowerCase(),
                      );
                      if (!cb || cb.costBasisUsd <= 0) return null;
                      const sourceLabel = {
                        "fiat-direct": "из фиата (точно)",
                        "fiat-stable": "≈ из фиата (стейбл)",
                        inherited: "наследовано",
                        unknown: "?",
                      }[cb.source as "fiat-direct" | "fiat-stable" | "inherited" | "unknown"] ?? cb.source;
                      return (
                        <span
                          className="ml-1 inline-block rounded border border-emerald-500/40 bg-emerald-500/10 px-1 py-0.5 text-[9px] uppercase tracking-wider text-emerald-400"
                          title={`Cost basis из CEX-цепочки: $${cb.costBasisUsd.toFixed(2)} (${sourceLabel}). Это «стартовый капитал» для этого ${cb.asset} — отслежен от P2P/трейдов на бирже до выводе сюда.`}
                        >
                          $ {cb.costBasisUsd.toFixed(2)}
                        </span>
                      );
                    })()}
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
                    <div className="inline-flex items-center gap-2">
                      <a
                        href={explorerUrl(op)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 font-mono text-[10px] text-brand-cyan hover:underline"
                      >
                        {shortAddress(op.hash, 6, 4)}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                      <button
                        type="button"
                        onClick={() => setEditingOp(op)}
                        title={
                          annotationsByKey.get(
                            `${realWalletId(op.wallet.id)}|${op.hash.toLowerCase()}|0`,
                          )
                            ? "Аннотация задана — нажмите для редактирования"
                            : "Добавить аннотацию (UCB A3)"
                        }
                        className={
                          "rounded border px-1.5 py-0.5 text-[10px] transition " +
                          (annotationsByKey.get(
                            `${realWalletId(op.wallet.id)}|${op.hash.toLowerCase()}|0`,
                          )
                            ? "border-brand-cyan/60 bg-brand-cyan/10 text-brand-cyan"
                            : "border-border text-muted-foreground hover:bg-accent/40")
                        }
                      >
                        ✎
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile: карточки */}
        <ul className="md:hidden divide-y divide-border border-y border-border">
          {ops.map((op) => {
            const cex = cexLinkByHash.get(op.hash.toLowerCase());
            const cb = cexCostBasisByHash.get(op.hash.toLowerCase());
            const annotKey = `${realWalletId(op.wallet.id)}|${op.hash.toLowerCase()}|0`;
            const hasAnnot = !!annotationsByKey.get(annotKey);
            const lpCloseUsd = lpCloseUsdByHash.get(`${op.wallet.id}|${op.hash}`);
            const inMv = op.movement.find((m) => m.direction === "in" && m.amount > 0);
            return (
              <li key={op.wallet.id + op.chain + op.hash} className="px-4 py-3 text-xs">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded border border-border bg-secondary px-1.5 py-0.5 text-[10px]",
                          op.wallet.chain === "sol" ? "text-[#14F195]" : "text-brand-cyan",
                        )}
                      >
                        <Wallet className="h-3 w-3" />
                        {op.wallet.name}
                      </span>
                      <Badge variant="outline" className="uppercase text-[10px]">{op.chain}</Badge>
                    </div>
                    <div className="mt-1 text-[10px] text-muted-foreground tabular-nums">
                      {formatDateTime(op.time)}
                    </div>
                  </div>
                  <a
                    href={explorerUrl(op)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-[10px] text-brand-cyan hover:underline shrink-0"
                  >
                    {shortAddress(op.hash, 6, 4)}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>

                <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                  <span className="font-mono text-[10px] text-muted-foreground">{op.type}</span>
                  {op.status === "failed" && (
                    <span className="text-[10px] uppercase tracking-wider text-destructive">· failed</span>
                  )}
                  {internalHashes.has(op.hash) && (
                    <span className="inline-block rounded border border-brand-cyan/40 bg-brand-cyan/10 px-1 py-0.5 text-[9px] uppercase tracking-wider text-brand-cyan">
                      ↔ internal
                    </span>
                  )}
                  {cex && (
                    <span className="inline-block rounded border border-purple-500/40 bg-purple-500/10 px-1 py-0.5 text-[9px] uppercase tracking-wider text-purple-400">
                      ↔ {cex.label ? `${cex.exchange}/${cex.label}` : cex.exchange}
                    </span>
                  )}
                  {cb && cb.costBasisUsd > 0 && (
                    <span className="inline-block rounded border border-emerald-500/40 bg-emerald-500/10 px-1 py-0.5 text-[9px] uppercase tracking-wider text-emerald-400">
                      $ {cb.costBasisUsd.toFixed(2)}
                    </span>
                  )}
                </div>

                <div className="mt-2">
                  <Movements op={op} locale={locale} />
                </div>

                <div className="mt-1.5">
                  <ManualAnnotationCell
                    walletId={op.wallet.id}
                    chain={op.chain}
                    hash={op.hash}
                    {...(inMv && {
                      primaryToken: { symbol: inMv.symbol, amount: inMv.amount },
                    })}
                  />
                </div>

                {op.type === "lp_remove" && lpCloseUsd != null && (
                  <div className="mt-1 inline-block rounded border border-blue-500/40 bg-blue-500/10 px-1 py-0.5 text-[9px] text-blue-400">
                    cost basis +{formatUsd(lpCloseUsd, locale)}
                  </div>
                )}

                <dl className="mt-2 grid grid-cols-1 gap-x-3 gap-y-1">
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Протокол</dt>
                    <dd className="text-right truncate">
                      {op.protocol ? (
                        <span className="inline-flex items-center gap-1">
                          <span className="font-medium text-foreground">{op.protocol.name}</span>
                          {op.detection === "auto" && (
                            <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 text-[9px] font-bold uppercase text-amber-500">
                              auto
                            </span>
                          )}
                        </span>
                      ) : op.counterparty ? (
                        <span className="font-mono text-[10px]">{shortAddress(op.counterparty, 6, 4)}</span>
                      ) : op.fnName ? (
                        <span className="font-mono text-[10px]">{op.fnName}</span>
                      ) : (
                        "—"
                      )}
                    </dd>
                  </div>
                  {op.gasUsd != null && op.gasUsd > 0 && (
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">Газ</dt>
                      <dd className="tabular-nums text-muted-foreground">{formatUsd(op.gasUsd, locale)}</dd>
                    </div>
                  )}
                </dl>

                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setEditingOp(op)}
                    className={
                      "rounded border px-2 py-1 text-[10px] transition " +
                      (hasAnnot
                        ? "border-brand-cyan/60 bg-brand-cyan/10 text-brand-cyan"
                        : "border-border text-muted-foreground hover:bg-accent/40")
                    }
                  >
                    ✎ {hasAnnot ? "Аннотация" : "Аннотировать"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
      {editingOp && (
        <OpAnnotationDialog
          open
          onClose={() => setEditingOp(null)}
          chainOpId={
            annotationsByKey.get(
              `${realWalletId(editingOp.wallet.id)}|${editingOp.hash.toLowerCase()}|0`,
            )?.chainOpId ?? null
          }
          walletId={realWalletId(editingOp.wallet.id)}
          txHash={editingOp.hash.toLowerCase()}
          logIndex={0}
          opType={editingOp.type}
          current={
            annotationsByKey.get(
              `${realWalletId(editingOp.wallet.id)}|${editingOp.hash.toLowerCase()}|0`,
            ) ?? null
          }
        />
      )}
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
  registrySync,
  onAddWallet,
}: {
  wallets: ReturnType<typeof useWallets>;
  loadedById: Record<string, Loaded>;
  formOpen: boolean;
  onToggleForm: () => void;
  debankKeyOk: boolean;
  heliusKeyOk: boolean;
  registrySync: ReturnType<typeof useRegistryApiSync>;
  /** Owned by parent (RegistryPage) — обёртка над `registrySync.onAdd`
   *  которая управляет «подключаем…»-карточкой статуса. */
  onAddWallet: (input: {
    name: string;
    address: string;
    chain: WalletChain;
    connectionId?: string;
  }) => Promise<void>;
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
                  void registrySync.onRemove(w.id);
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
                  // Закрываем форму сразу — карточка статуса
                  // (`PendingAddCard`) дальше показывает прогресс.
                  // `onAddWallet` fire-and-forget потому что parent
                  // page трекает результат через `pendingAdd`-state.
                  void onAddWallet(input);
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
  // Полная синхронизация теперь включает и CEX-биржи: ребята жаловались
  // что после reload приходится дёргать «Обновить» по одной кнопке на
  // КАЖДОЙ бирже в подразделах P2P/Переводы. Объединяем в одну кнопку.
  const cexAccountsQ = useCexAccounts();
  const cexAccountsCount = cexAccountsQ.data?.length ?? 0;
  const syncAllCex = useSyncAllCex();
  const isBusy = Boolean(busyId) || syncAllCex.isPending;

  const loaded = Object.values(loadedById);
  if (loaded.length === 0 && cexAccountsCount === 0) return null;

  const oldestLoadedAt =
    loaded.length > 0 ? Math.min(...loaded.map((l) => l.loadedAt)) : Date.now();
  const ageMs = Date.now() - oldestLoadedAt;
  const ageHours = ageMs / 3_600_000;

  const ageLabel =
    ageHours < 1
      ? `${Math.max(1, Math.round(ageMs / 60_000))} ${locale === "ru" ? "мин" : "min"}`
      : ageHours < 24
      ? `${Math.round(ageHours)} ${locale === "ru" ? "ч" : "h"}`
      : `${Math.round(ageHours / 24)} ${locale === "ru" ? "д" : "d"}`;

  const stale = ageHours > 1;

  const handleRefreshAll = async (opts?: { full?: boolean }) => {
    // Параллелим: wallets-refresh и CEX-sync независимы. Внутри CEX
    // sync-all сам идёт последовательно по аккаунтам — не упрёмся в
    // 429. Все ошибки локализованы в своих promise'ах и не валят друг
    // друга.
    const tasks: Promise<unknown>[] = [];
    if (wallets.list.length > 0)
      tasks.push(loadAll(opts?.full ? { full: true } : undefined));
    if (cexAccountsCount > 0) tasks.push(syncAllCex.mutateAsync());
    await Promise.allSettled(tasks);
  };

  // Свожу результаты CEX в одну строку для inline-фидбэка.
  const cexSummary = (() => {
    const r = syncAllCex.data;
    if (!r || r.length === 0) return null;
    const dep = r.reduce((s, x) => s + (x.transfers?.newDeposits ?? 0), 0);
    const wd = r.reduce((s, x) => s + (x.transfers?.newWithdrawals ?? 0), 0);
    const trades = r.reduce((s, x) => s + (x.balance?.newTrades ?? 0), 0);
    const p2p = r.reduce((s, x) => s + (x.p2p?.newOrders ?? 0), 0);
    const errs = r.filter(
      (x) =>
        (x.balance && !x.balance.ok) ||
        (x.transfers && !x.transfers.ok) ||
        (x.p2p && !x.p2p.ok),
    );
    return { dep, wd, trades, p2p, errs };
  })();

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-secondary/40 px-4 py-2 text-xs text-muted-foreground">
      <div>
        <span className={stale ? "text-warning" : "text-success"}>●</span>{" "}
        {t("registry.cache.updated")}{" "}
        <span className="font-medium text-foreground">{ageLabel}</span>{" "}
        {t("registry.cache.ago")} · {loaded.length}/{wallets.list.length}{" "}
        {t("registry.cache.wallets")}
        {cexAccountsCount > 0 && (
          <>
            {" · "}
            <span className="text-brand-cyan">
              {cexAccountsCount} CEX
            </span>
          </>
        )}{" "}
        ·{" "}
        <span className="font-mono text-[10px]">
          cache v{CURRENT_CACHE_VERSION}
        </span>
        {cexSummary && (
          <span className="ml-2 text-[10px] text-muted-foreground">
            · last CEX sync: +{cexSummary.trades} trades · +{cexSummary.dep}
            /-{cexSummary.wd} transfers · +{cexSummary.p2p} P2P
            {cexSummary.errs.length > 0 && (
              <span className="ml-1 text-warning">
                ({cexSummary.errs.length} err)
              </span>
            )}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={isBusy}
          onClick={() => void handleRefreshAll()}
          title="Инкрементальный refresh: кошельки + балансы/трейды/переводы/P2P на всех CEX"
        >
          {syncAllCex.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RotateCw className="h-3.5 w-3.5" />
          )}
          Обновить всё
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={isBusy}
          onClick={() => {
            if (window.confirm(t("registry.cache.confirmFull")))
              void handleRefreshAll({ full: true });
          }}
          title="Полный рефреш: переcчитать кошельки с нуля + синхронизация CEX"
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

/* ============================ Pending-add status card ==================== */

/**
 * Видимая карточка «подключаем кошелёк / загружаем операции». До этого
 * фикса юзеры жаловались что «сервис висит» после submit'а: форма
 * закрывалась, а API + hydration + DeBank pull в сумме шли 5–60 секунд
 * без какой-либо обратной связи. Карточка проходит 3 фазы:
 *   1. «Сохраняем адрес на сервере…»        — пока `apiWalletId` не задан
 *   2. «Загружаем операции — N ops / M pages» — пока кошелёк не появился в
 *      `loadedById`. Прогресс реальный — приходит из LoadedWalletsProvider.
 *   3. «✓ Готово — N операций загружено»     — `done=true`, через 3с
 *      auto-dismiss.
 *
 * Ошибки (API упал) — красный вариант с кнопкой «Закрыть».
 */
function PendingAddCard({
  pending,
  progress,
  onDismiss,
}: {
  pending: {
    startedAt: number;
    name: string;
    address: string;
    chain: WalletChain;
    apiWalletId?: string;
    localId?: string;
    done?: boolean;
    error?: string;
  };
  progress: { loaded: number; pages: number } | null;
  onDismiss: () => void;
}): JSX.Element {
  const { error, done, apiWalletId, name, address } = pending;
  const elapsedSec = Math.floor((Date.now() - pending.startedAt) / 1000);

  const variantCls = error
    ? "border-destructive/50 bg-destructive/10"
    : done
      ? "border-success/50 bg-success/10"
      : "border-brand-cyan/50 bg-brand-cyan/5";

  const iconCls = error
    ? "text-destructive"
    : done
      ? "text-success"
      : "text-brand-cyan";

  return (
    <Card className={cn("border-2", variantCls)}>
      <CardContent className="flex items-start gap-3 py-4">
        <div className={cn("mt-0.5 shrink-0", iconCls)}>
          {error ? (
            <X className="h-5 w-5" />
          ) : done ? (
            <Check className="h-5 w-5" />
          ) : (
            <Loader2 className="h-5 w-5 animate-spin" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">
            {error
              ? `Не удалось подключить «${name}»`
              : done
                ? `Кошелёк «${name}» подключён`
                : `Подключаем кошелёк «${name}»…`}
          </p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
            {shortAddress(address, 8, 6)}
          </p>
          {error ? (
            <p className="mt-1.5 text-xs text-destructive">{error}</p>
          ) : done ? (
            <p className="mt-1.5 text-xs text-muted-foreground">
              Загружено {progress?.loaded ?? 0} операций
              {progress?.pages
                ? ` за ${progress.pages} страниц истории`
                : ""}
              . Подключите ещё кошелёк или биржу — или начните анализ внизу
              страницы.
            </p>
          ) : !apiWalletId ? (
            <p className="mt-1.5 text-xs text-muted-foreground">
              Сохраняем адрес на сервере…
            </p>
          ) : (
            <>
              <p className="mt-1.5 text-xs text-muted-foreground">
                Загружаем историю операций с блокчейна — это может занять
                30–60 секунд. <b>Не закрывайте страницу.</b>
                {progress && (progress.loaded > 0 || progress.pages > 0) && (
                  <>
                    {" "}
                    Уже подтянули{" "}
                    <span className="font-mono text-foreground">
                      {progress.loaded}
                    </span>{" "}
                    операций
                    {progress.pages > 0 && (
                      <>
                        {" / "}
                        <span className="font-mono text-foreground">
                          {progress.pages}
                        </span>{" "}
                        стр.
                      </>
                    )}
                  </>
                )}
              </p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                Прошло: {elapsedSec}с
              </p>
            </>
          )}
        </div>
        {(error || done) && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={onDismiss}
            aria-label="Закрыть"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/* ============================ API sync hook ============================== */

/**
 * Mirrors RegistryPage's add/remove into the SaaS wallets table.
 *
 * Without this the page used to write only to localStorage; the wallets
 * stayed device-local, the worker never refreshed them, and
 * admin/portfolios reported zero TVL for everyone. After this hook is
 * in place RegistryPage stays the same UX (form, cards, delete button)
 * but every mutation also lands in the API so:
 *   - same wallet visible on every device the user logs in from
 *   - admin/portfolios sees the real capital
 *   - hourly cron refresh runs for it
 *
 * Legacy migration runs once on mount: any localStorage entry without
 * the `api:` prefix is created via the API; on success it's removed
 * from localStorage and the hydration query reissues it as
 * `api:<walletId>:<addressId>`.
 */
/**
 * Result of an Add operation. Discriminated так чтобы UI мог различать
 * «успех через API» (ждём hydration + load), «локально только»
 * (нет primary account — degraded), «дубль» (адрес уже есть в списке).
 */
export type RegistryAddResult =
  | { kind: "api"; apiWalletId: string }
  | { kind: "local"; wallet: SavedWallet }
  | { kind: "duplicate" };

function useRegistryApiSync(
  wallets: ReturnType<typeof useWallets>,
): {
  onAdd: (input: { name: string; address: string; chain: WalletChain; connectionId?: string }) => Promise<RegistryAddResult>;
  onRemove: (localId: string) => Promise<void>;
  migrating: boolean;
} {
  const primary = useActiveAccount();
  const qc = useQueryClient();
  // Migration was a one-time bridge from pre-SaaS localStorage entries
  // to the API. After Hydration switched to server-only mode, legacy
  // entries are dropped on the next render, so the migration loop only
  // double-created. Removed.

  const onAdd = useCallback(
    async (input: { name: string; address: string; chain: WalletChain; connectionId?: string }): Promise<RegistryAddResult> => {
      if (!primary) {
        // No primary account — degrade gracefully, the dashboard's
        // hydration will catch up when the account boot resolves.
        const local = wallets.add(input);
        return { kind: "local", wallet: local };
      }
      // Dedupe by address against current API-sourced entries before
      // creating to prevent double-add races (form submit + hydration
      // refetch arriving close together).
      const lower = input.address.trim().toLowerCase();
      if (wallets.list.some((w) => w.address.toLowerCase() === lower)) {
        return { kind: "duplicate" };
      }
      try {
        const apiW = await walletsApi.create(primary.id, {
          name: input.name,
          kind: "external",
        });
        await walletsApi.addAddress(primary.id, apiW.id, {
          address: input.address,
          type: walletChainToType(input.chain),
          chains: input.chain === "evm" ? EVM_DEFAULT_CHAINS : [],
        });
        // Без инвалидации hydration query refetch'ит только через
        // `staleTime: 30_000` — пользователь видит «пустоту» до 30
        // секунд после submit'а. Это и было корневой причиной жалобы
        // «всё висит после подключения кошелька».
        await Promise.all([
          qc.invalidateQueries({ queryKey: ["wallets", "list", primary.id] }),
          qc.invalidateQueries({
            queryKey: ["wallets", "addresses", primary.id, apiW.id],
          }),
        ]);
        return { kind: "api", apiWalletId: apiW.id };
      } catch (err) {
        console.error("[registry] api create failed", err);
        throw err;
      }
    },
    [primary, wallets, qc],
  );

  const onRemove = useCallback(
    async (localId: string) => {
      // After the server-only hydration switch every wallet id should
      // be `api:<wid>:<aid>`. Local-only ids no longer survive past
      // hydration, but we keep the fallback for safety.
      if (localId.startsWith("api:") && primary) {
        const apiWalletId = localId.split(":")[1];
        if (apiWalletId) {
          try {
            await walletsApi.delete(primary.id, apiWalletId);
            return;
          } catch (err) {
            console.error("[registry] api delete failed", err);
          }
        }
      }
      wallets.remove(localId);
    },
    [primary, wallets],
  );

  return { onAdd, onRemove, migrating: false };
}

const EVM_DEFAULT_CHAINS = [1, 42161, 8453, 10, 137, 56];

function walletChainToType(chain: WalletChain): AddressType {
  switch (chain) {
    case "evm":
      return "evm";
    case "sol":
      return "solana";
    case "coinstats":
      return "other";
    default:
      return "other";
  }
}
