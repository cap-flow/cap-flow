/**
 * Общий контекст для загруженных on-chain кошельков.
 *
 * Раньше RegistryPage держал это в локальном state — но теперь LedgerPage
 * тоже хочет читать те же ClassifiedOp[], чтобы сгенерировать ручной учёт.
 * Поэтому подняли state на уровень App.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  fetchAllComplexProtocolList,
  fetchAllHistory,
  fetchAllTokenList,
  fetchTotalBalance,
  type DeBankHistoryItem,
  type DeBankProject,
  type DeBankToken,
} from "@/lib/debank";
import {
  fetchAllHeliusHistory,
  fetchHeliusBalances,
  type HeliusTransaction,
} from "@/lib/helius";
import { fetchJupiterPrices, fetchJupiterPortfolio } from "@/lib/jupiter";
import { fetchVybeDefiPositions } from "@/lib/vybe";
import {
  adaptCoinStatsLive,
  adaptDeBankLive,
  adaptJupiterPortfolioLive,
  adaptSolanaLive,
  adaptVybeLive,
} from "@/lib/portfolio/live_adapters";
import {
  fetchWalletBalance as fetchCoinStatsBalance,
  fetchWalletDefi as fetchCoinStatsDefi,
} from "@/lib/coinstats";
import type { LiveSnapshot } from "@/lib/portfolio/live";
import { SOL_NATIVE_MINT } from "@/lib/portfolio/spl_tokens";
import { classifyHistory } from "@/lib/portfolio/classifier";
import { linkAsyncDeposits } from "@/lib/portfolio/async_deposit_linker";
import { runUcbPipelineForWallet } from "@/lib/portfolio/ucb_pipeline";
import type { LotTracker } from "@/lib/portfolio/lots";
import type { PositionTracker } from "@/lib/portfolio/positions";
import { classifyHeliusHistory } from "@/lib/portfolio/solana_classifier";
import { buildSnapshot } from "@/lib/portfolio/reducer";
import type {
  ClassifiedOp,
  PortfolioSnapshot,
} from "@/lib/portfolio/types";
import { useIntegrations } from "@/lib/integrations";
import { useAppConfig } from "@/features/app-config/hooks";
import { useWallets, type SavedWallet, type WalletChain } from "@/lib/wallets";
import { useAuth } from "@/features/auth/AuthProvider";
import { chainOpsApi, type ChainOpInput } from "@/features/chain-ops/api";
import {
  useAnnotations,
  useGraphInternalTransfers,
} from "@/features/chain-ops/hooks";
import {
  deleteWalletCache,
  readAllWalletCacheIds,
  readWalletCache,
  setCacheUserScope,
  writeWalletCache,
} from "@/lib/cache";
import { findInternalTransferPairs } from "@/lib/portfolio/internal_transfers";
import { computeFiatHopCostBasisOverrides } from "@/lib/portfolio/lots/fiat_hop_cost_basis";
import { computeCrossWalletCostBasisOverrides } from "@/lib/portfolio/lots/cross_wallet_cost_basis";
import {
  useCexTransfersWithHash,
  useCexWithdrawalCostBasis,
  useUpsertDepositSeeds,
} from "@/features/cex/hooks";
import { computeDepositSeedsFromOps } from "@/lib/portfolio/deposit_seeds";
import { fetchJupiterTokenMetaBatch } from "@/lib/jupiter_tokens";
import { fetchDexScreenerTokenBatch } from "@/lib/dexscreener";
import {
  fetchSolscanDefiActivities,
  mapSolscanActivityToOpType,
  type SolscanDefiActivity,
} from "@/lib/solscan";
import {
  fetchShyftTransactionHistory,
  fetchShyftTokenMeta,
  mapShyftTypeToOpType,
} from "@/lib/shyft";

/**
 * Feature flag — пока фокусируемся только на EVM через DeBank Cloud API.
 * Solana и CoinStats-цепочки (TON/BTC/Aptos/Sui/…) поставлены на паузу:
 * провайдеры всё ещё подключены в коде, но к ним не идём, чтобы не тратить
 * квоты и не путать UI частичными данными. Чтобы вернуть их обратно —
 * переключите в `true`.
 */
const ENABLE_NON_EVM_PROVIDERS = false;

/**
 * Дефолты пагинации истории DeBank. Переопределяются админ-настройками
 * (`debank.historyMaxPagesFirstLoad` / `debank.historyMaxPagesIncremental`)
 * через `useAppConfig()`; эти константы — fallback до загрузки конфига и для
 * сред без backend-настроек.
 *   - FIRST_LOAD: первый бэкфилл кошелька — грузим до конца истории.
 *   - INCREMENTAL: при наличии полного кэша тянем лишь новое сверху.
 */
const HISTORY_MAX_PAGES_FIRST_LOAD_DEFAULT = 500;
const HISTORY_MAX_PAGES_INCREMENTAL_DEFAULT = 5;
/** Мин. интервал авто-рефреша (дефолт; переопределяется настройкой). */
const AUTO_REFRESH_MIN_INTERVAL_MS_DEFAULT = 60 * 60 * 1000;

export interface Loaded {
  wallet: SavedWallet;
  ops: ClassifiedOp[];
  snapshot: PortfolioSnapshot;
  loadedAt: number;
  /** Текущее on-chain состояние, чейн-нейтрально (EVM + Solana). */
  live?: LiveSnapshot;
  /**
   * `true`, если история кошелька была пагинирована до естественного конца
   * (полный бэкфилл). Управляет выбором `maxPages` при следующей загрузке:
   *   - `true`  → инкремент (малый cap, тянем лишь новое сверху);
   *   - не-true → полный бэкфилл (большой cap) — старшие операции ещё не все.
   * Только EVM/DeBank; для Solana/CoinStats не выставляется.
   */
  historyComplete?: boolean;
}

interface LoadProgress {
  walletId: string;
  pages: number;
  loaded: number;
}

interface Ctx {
  loadedById: Record<string, Loaded>;
  busyId: string | null;
  progress: LoadProgress | null;
  error: string | null;
  /**
   * Этап 12: новые трекеры (lots + positions event log) запускаются
   * параллельно. Доступны для inspection / отладки / future migration
   * существующего кода. На текущие расчёты UI не влияют — startUsd
   * по-прежнему считается через legacy `cost_basis_tracker.ts` +
   * `currentCostBasisForPosition`.
   */
  newTrackers: {
    /** Per-wallet `LotTracker` instance. */
    lotsByWallet: Map<
      string,
      import("@/lib/portfolio/lots").LotTracker
    >;
    /** Per-wallet `PositionTracker` instance. */
    positionsByWallet: Map<
      string,
      import("@/lib/portfolio/positions").PositionTracker
    >;
  };
  /**
   * UCB C5.3: composite-key annotations map (`${walletId}|${txHash}|${logIndex}`)
   * exposed for downstream consumers (AssetsPage и т.д.), которым нужно
   * прогнать собственные UCB-аналитики через `runUcbPipeline`.
   *
   * Передаётся как-есть — каждый consumer сам решает что фильтровать.
   * D8 exclusions гарантированно работают везде где этот map используется.
   */
  annotationsByKey: ReadonlyMap<string, import("@/features/chain-ops/api").ResolvedAnnotation>;
  /**
   * UCB C5.3: merged cost basis overrides по tx hash. Содержит CEX
   * inheritance (D3) + manual annotations (A4.2). НЕ содержит bridge WAC
   * (D5 computed inside lot tracker через state). По умолчанию это
   * shared map — все wallets читают из одного places. Consumer'у нужно
   * самому фильтровать per-wallet если нужно.
   */
  costBasisOverrideByHash: ReadonlyMap<string, number>;
  /**
   * Загрузить кошелёк. По умолчанию — incremental: подтягивает только новые
   * операции, появившиеся после последней синхронизации (если кэш есть).
   * Передай `{ full: true }`, чтобы переподтянуть всё с нуля.
   */
  load: (wallet: SavedWallet, options?: { full?: boolean }) => Promise<Loaded | null>;
  loadAll: (options?: { full?: boolean }) => Promise<void>;
  cancel: () => void;
  clearError: () => void;
  forget: (walletId: string) => void;
  forgetAll: () => void;
  /**
   * Пары операций, обнаруженные как internal-transfers между двумя
   * пользовательскими кошельками. Используется для:
   *   - корректировки cost basis (на принимающем кошельке cost basis
   *     наследуется с отправляющего, не списывается как продажа);
   *   - UI-маркеров «между своими» в Реестре операций.
   * Пересчитывается автоматически при изменении `loadedById`.
   */
  internalPairs: import("@/lib/portfolio/internal_transfers").InternalPair[];
  /**
   * Set хешей операций (`tx hash`), которые попали в internal-pairs.
   * Быстрая проверка `internalHashes.has(op.hash)` для UI и reducer'а.
   */
  internalHashes: Set<string>;
}

const LoadedCtx = createContext<Ctx | null>(null);

export function LoadedWalletsProvider({ children }: { children: React.ReactNode }) {
  const [integrations] = useIntegrations();
  const wallets = useWallets();
  const { user } = useAuth();

  // Гидратация из localStorage — мы НЕ можем сделать её в useState
  // инициализаторе, потому что `readAllWalletCacheIds` зависит от
  // `currentUserId` в lib/cache.ts, а тот выставляется через
  // `setCacheUserScope` в useEffect ниже (после первого рендера).
  // Initializer бы возвращал пустой объект → bootstrap-effect видел
  // пустой `loadedById` → запускал full sync через DeBank каждый
  // page reload (M-2026-05-14 bug: пропадал баланс + жглись API-кредиты).
  //
  // Поэтому гидрация делается в useEffect-е ниже, который сначала
  // ставит scope, потом читает кэш. Bootstrap ждёт через `hydrationDone`.
  const [loadedById, setLoadedById] = useState<Record<string, Loaded>>({});
  const [hydrationDone, setHydrationDone] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Настройки пагинации/рефреша из backend app-config (см. useAppConfig ниже).
  // Держим в ref, чтобы стабильный `load` useCallback читал свежие значения
  // без пересоздания. Дефолты — fallback до загрузки конфига.
  const appConfigRef = useRef({
    historyMaxPagesFirstLoad: HISTORY_MAX_PAGES_FIRST_LOAD_DEFAULT,
    historyMaxPagesIncremental: HISTORY_MAX_PAGES_INCREMENTAL_DEFAULT,
    autoRefreshMinIntervalMs: AUTO_REFRESH_MIN_INTERVAL_MS_DEFAULT,
  });
  // Подтягиваем admin-настройки (frontend-кнобы) и держим их в ref, чтобы
  // стабильный `load` и авто-рефреш читали свежие значения без пересоздания.
  const { config: appConfig } = useAppConfig();
  appConfigRef.current = {
    historyMaxPagesFirstLoad: appConfig.historyMaxPagesFirstLoad,
    historyMaxPagesIncremental: appConfig.historyMaxPagesIncremental,
    autoRefreshMinIntervalMs: appConfig.autoRefreshMinIntervalMs,
  };

  const keyFor = useCallback(
    (chain: WalletChain): string => {
      if (chain === "sol") return integrations.heliusApiKey.trim();
      if (chain === "coinstats")
        return (integrations.coinstatsApiKey ?? "").trim();
      return integrations.debankAccessKey.trim();
    },
    [integrations],
  );

  const load = useCallback(
    async (
      wallet: SavedWallet,
      options?: { full?: boolean },
    ): Promise<Loaded | null> => {
      setError(null);
      const apiKey = keyFor(wallet.chain);
      if (!apiKey) {
        setError("API key is missing");
        return null;
      }

      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setBusyId(wallet.id);
      setProgress({ walletId: wallet.id, pages: 0, loaded: 0 });

      // Инкрементальный режим: если кэш есть и full не запрошен — берём
      // только новые операции (после самой свежей в кэше).
      let cached = options?.full ? null : loadedById[wallet.id];

      // UCB B5.3 Phase 2 (inline): если client cache пуст (fresh device,
      // первый заход после login, или RegistryPage auto-load для wallet'а
      // которого bootstrap ещё не успел тронуть), пробуем server-side
      // cache СИНХРОННО внутри load(). Это даёт:
      //   1. Instant paint — UI получает ops до того как DeBank успеет
      //      ответить (Phase 2 hydration goal).
      //   2. knownHashes для delta-refresh — DeBank pull сразу стопится
      //      на первой known op вместо full re-pull (B5.4).
      //   3. Защиту от race с bootstrap effect (RegistryPage может дёрнуть
      //      load до того как bootstrap эту wallet выберет).
      if (!cached && !options?.full) {
        const fromServer = await tryHydrateFromServer(wallet).catch(() => null);
        if (fromServer && fromServer.ops.length > 0) {
          cached = fromServer;
          // Instant paint: ставим server-ops в loadedById сразу, до того как
          // DeBank/Helius/CEX дернутся. UI отрисует cost basis / историю
          // мгновенно — live tokens долетят позже в этом же `load()`.
          setLoadedById((prev) =>
            prev[wallet.id] ? prev : { ...prev, [wallet.id]: fromServer },
          );
        }
      }

      const knownHashes = cached ? new Set(cached.ops.map((o) => o.hash)) : null;

      // UCB B5.4: delta-refresh через server `latestOpTime`. Срабатывает
      // только если ни client cache ни server-hydration не дали данных
      // (всё пусто / explore-wallet / новый wallet). Это тонкий safety-net:
      // даже если `tryHydrateFromServer` ничего не вернул, `latestOpTime`
      // мог быть установлен из предыдущего sync без `raw` payload (legacy).
      let serverLatestOpTime: number | null = null;
      if (!cached && !options?.full) {
        try {
          serverLatestOpTime = await fetchServerLatestOpTime(wallet.id);
        } catch {
          serverLatestOpTime = null;
        }
      }

      try {
        let newOps: ClassifiedOp[];
        // Для EVM/DeBank: завершён ли полный бэкфилл истории (см. ниже).
        // undefined для не-EVM — там флаг не ведём.
        let historyComplete: boolean | undefined;
        const ownAddresses = new Set(
          wallets.list.map((w) => w.address.toLowerCase()),
        );
        // Результат Shyft TX-обогащения; передаётся из Solana classifier
        // в live.sources ниже (объявлен здесь чтобы быть в scope обоих).
        let shyftTxResult: {
          ok: boolean;
          enriched?: number;
          txCount?: number;
          error?: string;
        } | null = null;

        if (wallet.chain === "coinstats") {
          // CoinStats: ops history через CoinStats требует sync и даёт
          // менее детальные события чем DeBank/Helius. Уровень 0 — без
          // истории, только live state. Cost basis / PnL не считаются.
          newOps = [];
        } else if (wallet.chain === "evm") {
          const allHistory: DeBankHistoryItem[] = [];
          const tokens: Record<string, DeBankToken> = {};
          const projects: Record<string, DeBankProject> = {};
          const cex: Record<string, { id: string; name: string }> = {};
          // Полный бэкфилл vs инкремент. Инкремент — ТОЛЬКО когда предыдущая
          // загрузка дотянула историю до конца (`historyComplete === true`).
          // Иначе (нет кэша ИЛИ прошлый бэкфилл упёрся в cap) делаем полный
          // бэкфилл с БОЛЬШИМ cap и БЕЗ stopWhen — иначе stopWhen стопнулся бы
          // на первой известной (свежей) tx и не дотянул бы пропущенное старое.
          const cfg = appConfigRef.current;
          const isIncremental = cached?.historyComplete === true;
          const historyMaxPages = isIncremental
            ? cfg.historyMaxPagesIncremental
            : cfg.historyMaxPagesFirstLoad;
          const useStopWhen =
            isIncremental && (knownHashes != null || serverLatestOpTime !== null);
          const histRes = await fetchAllHistory(
            {
              address: wallet.address,
              accessKey: apiKey,
              maxPages: historyMaxPages,
              onPage: (page, idx) => {
                allHistory.push(...page.history_list);
                Object.assign(tokens, page.token_dict);
                Object.assign(projects, page.project_dict);
                for (const [k, v] of Object.entries(page.cex_dict)) cex[k] = v;
                setProgress({
                  walletId: wallet.id,
                  pages: idx + 1,
                  loaded: allHistory.length,
                });
              },
              ...(useStopWhen && {
                stopWhen: (it: DeBankHistoryItem) => {
                  // hash-based stop: дешёвый — точное совпадение по id.
                  if (knownHashes && knownHashes.has(it.id)) return true;
                  // time-based stop (B5.4): records `time_at <= latestOpTime`
                  // уже синканы на сервере, дальше pagination бессмыслен.
                  if (
                    serverLatestOpTime !== null &&
                    it.time_at <= serverLatestOpTime
                  ) {
                    return true;
                  }
                  return false;
                },
              }),
            },
            ctrl.signal,
          );
          // Инкремент-режим уже подразумевает полную историю в кэше → остаётся
          // complete. Полный бэкфилл: complete только если дошли до конца.
          historyComplete = isIncremental ? true : histRes.reachedEnd;
          newOps = classifyHistory(allHistory, {
            ownAddresses,
            selfAddress: wallet.address.toLowerCase(),
            tokens,
            projects,
            cex,
          });
          // Линкуем парные tx async-deposit/withdraw (GMX V2, GMSOL,
          // Flash Trade, …), чтобы Tx A (USDC out) знал mint LP-receipt'а
          // из своей Tx B (GM in). Без этого все маркеты одного протокола
          // сливаются в одну позицию в reducer'е.
          newOps = linkAsyncDeposits(newOps);
        } else {
          const ownSolAddresses = new Set(
            wallets.list.filter((w) => w.chain === "sol").map((w) => w.address),
          );
          const txs: HeliusTransaction[] = [];
          await fetchAllHeliusHistory(
            {
              address: wallet.address,
              apiKey,
              onPage: (page, idx) => {
                txs.push(...page);
                setProgress({
                  walletId: wallet.id,
                  pages: idx + 1,
                  loaded: txs.length,
                });
              },
              ...(knownHashes && {
                stopWhen: (tx: HeliusTransaction) => knownHashes.has(tx.signature),
              }),
            },
            ctrl.signal,
          );
          newOps = classifyHeliusHistory(txs, {
            selfAddress: wallet.address,
            ownAddresses: ownSolAddresses,
          });

          // Shyft post-classification: если у пользователя есть Shyft
          // API key — обогащаем `op.type` и `op.protocol` через
          // `/wallet/transaction_history`. Free tier 1M req/мес — почти
          // безграничный для одного юзера. Покрывает большинство Solana
          // DeFi протоколов (Meteora, Raydium V3, Drift, Kamino, Jupiter
          // Perps, Orca, и т.д.).
          // Shyft TX history enrichment. Источник `Shyft TX` будет добавлен
          // в `live.sources` ниже в Solana live ветке через `shyftTxResult`.
          const shyftKey = (integrations.shyftApiKey ?? "").trim();
          if (shyftKey && newOps.length > 0) {
            try {
              const shyftTxs = await fetchShyftTransactionHistory({
                address: wallet.address,
                apiKey: shyftKey,
                signal: ctrl.signal,
              });
              const bySig = new Map(shyftTxs.map((t) => [t.signature, t]));
              let enriched = 0;
              for (const op of newOps) {
                const tx = bySig.get(op.hash);
                if (!tx) continue;
                const mapped = mapShyftTypeToOpType(tx.type);
                if (!mapped) continue;
                const needType =
                  op.type === "unknown" || (op.type === "swap" && mapped !== "swap");
                const needProtocol = !op.protocol && tx.protocol?.name;
                if (needType) {
                  (op as { type: typeof mapped }).type = mapped;
                  enriched += 1;
                }
                if (needProtocol && tx.protocol) {
                  const platformId = tx.protocol.name
                    .toLowerCase()
                    .replace(/\s+/g, "_");
                  const category =
                    mapped === "lp_add" || mapped === "lp_remove"
                      ? "dex"
                      : mapped === "stake" || mapped === "unstake"
                        ? "staking"
                        : mapped === "lend_supply" ||
                            mapped === "lend_withdraw" ||
                            mapped === "borrow" ||
                            mapped === "repay"
                          ? "lending"
                          : "other";
                  (op as { protocol: typeof op.protocol }).protocol = {
                    id: platformId,
                    name: tx.protocol.name,
                    category,
                  };
                }
              }
              shyftTxResult = { ok: true, enriched, txCount: shyftTxs.length };
              if (enriched > 0) {
                console.info(
                  `Shyft enriched ${enriched} ops for wallet ${wallet.id}`,
                );
              }
            } catch (e) {
              if ((e as Error).name !== "AbortError") {
                console.warn("Shyft fetch failed:", e);
                shyftTxResult = { ok: false, error: (e as Error).message };
              }
            }
          } else if (!shyftKey) {
            shyftTxResult = { ok: false, error: "no API key" };
          }

          // Solscan post-classification: если у пользователя есть Solscan
          // API key — обогащаем `op.type` и `op.protocol` для tx, которые
          // Helius пометил как `unknown` или без protocol info.
          // Solscan parsed activities покрывают намного больше DeFi
          // протоколов (Sanctum, Meteora, Drift, Kamino, Raydium V3 и т.д.).
          const solscanKey = (integrations.solscanApiKey ?? "").trim();
          if (solscanKey && newOps.length > 0) {
            try {
              const activities = await fetchSolscanDefiActivities({
                address: wallet.address,
                apiKey: solscanKey,
                signal: ctrl.signal,
              });
              const bySig = new Map<string, SolscanDefiActivity>();
              for (const a of activities) bySig.set(a.signature, a);
              let enriched = 0;
              for (const op of newOps) {
                const a = bySig.get(op.hash);
                if (!a) continue;
                const mapped = mapSolscanActivityToOpType(a.activityType);
                if (!mapped) continue;
                const needType =
                  op.type === "unknown" || (op.type === "swap" && mapped !== "swap");
                const needProtocol = !op.protocol && a.platform;
                if (needType) {
                  // Reassign op.type. ClassifiedOp.type — это OpType union.
                  (op as { type: typeof mapped }).type = mapped;
                  enriched += 1;
                }
                if (needProtocol && a.platform) {
                  const platformId = a.platform.toLowerCase().replace(/\s+/g, "_");
                  const category =
                    mapped === "lp_add" || mapped === "lp_remove"
                      ? "dex"
                      : mapped === "stake" || mapped === "unstake"
                        ? "staking"
                        : mapped === "lend_supply" ||
                            mapped === "lend_withdraw" ||
                            mapped === "borrow" ||
                            mapped === "repay"
                          ? "lending"
                          : "other";
                  (op as { protocol: typeof op.protocol }).protocol = {
                    id: platformId,
                    name: a.platform,
                    category,
                  };
                }
              }
              if (enriched > 0) {
                console.info(
                  `Solscan enriched ${enriched} ops for wallet ${wallet.id}`,
                );
              }
            } catch (e) {
              if ((e as Error).name !== "AbortError") {
                console.warn("Solscan fetch failed:", e);
              }
            }
          }
        }

        // Объединяем новые операции с уже сохранёнными (если incremental).
        const ops: ClassifiedOp[] = cached
          ? mergeOps(cached.ops, newOps)
          : newOps;

        const snapshot = buildSnapshot(wallet.id, wallet.address, ops);

        // Live-state — текущие балансы и позиции (важно для UX: пользователь
        // хочет видеть «что у него сейчас лежит и где», а не только историю).
        let live: LiveSnapshot | undefined;

        if (wallet.chain === "evm") {
          // Promise.allSettled вместо Promise.all — если упадёт один из
          // источников (например, fetchTotalBalance из-за rate-limit), не
          // теряем остальные. Раньше atomic fail выкидывал весь EVM live.
          const [tokensRes, protocolsRes, totalRes] = await Promise.allSettled([
            fetchAllTokenList(
              { address: wallet.address, accessKey: apiKey, isAll: false },
              ctrl.signal,
            ),
            fetchAllComplexProtocolList(
              { address: wallet.address, accessKey: apiKey },
              ctrl.signal,
            ),
            fetchTotalBalance(
              { address: wallet.address, accessKey: apiKey },
              ctrl.signal,
            ),
          ]);
          const tokens = tokensRes.status === "fulfilled" ? tokensRes.value : [];
          const protocols =
            protocolsRes.status === "fulfilled" ? protocolsRes.value : [];
          const totalUsdFromApi =
            totalRes.status === "fulfilled" ? totalRes.value.total_usd_value : 0;
          // Live строим, даже если что-то упало (хотя бы частично покажем).
          if (
            tokensRes.status === "fulfilled" ||
            protocolsRes.status === "fulfilled"
          ) {
            live = adaptDeBankLive({
              wallet,
              tokens,
              protocols,
              totalUsd: totalUsdFromApi,
            });
            // Если total упал — пересчитаем по тому что есть, чтобы число
            // в шапке не было 0 при наличии токенов/позиций.
            if (totalRes.status !== "fulfilled") {
              live.totalUsd =
                live.tokens.reduce((s, t) => s + t.usd, 0) +
                live.positions.reduce((s, p) => s + p.netUsd, 0);
            }
            const errors: string[] = [];
            if (tokensRes.status === "rejected")
              errors.push(`tokens: ${(tokensRes.reason as Error).message}`);
            if (protocolsRes.status === "rejected")
              errors.push(`protocols: ${(protocolsRes.reason as Error).message}`);
            if (totalRes.status === "rejected")
              errors.push(`total: ${(totalRes.reason as Error).message}`);
            live.sources = [
              {
                name: "DeBank",
                ok: errors.length === 0,
                tokens: live.tokens.length,
                positions: live.positions.length,
                ...(errors.length > 0 && { error: errors.join("; ") }),
              },
            ];

            // DEX Screener fallback для EVM-токенов без цены. DeBank
            // обычно даёт цены для известных, но nove airdrop'ы / ниш'и
            // приходят с price=0 → отбрасываются dust-фильтром. DEX
            // Screener агрегирует цены со всех DEX-пулов, без ключа.
            const noPriceTokens = live.tokens
              .filter((t) => t.amount > 0 && (t.price == null || t.price <= 0))
              .map((t) => t.tokenId);
            if (noPriceTokens.length > 0) {
              try {
                const priceMap = await fetchDexScreenerTokenBatch(
                  noPriceTokens,
                  ctrl.signal,
                );
                let resolved = 0;
                for (const t of live.tokens) {
                  const data = priceMap.get(t.tokenId);
                  if (!data) continue;
                  t.price = data.priceUsd;
                  t.usd = t.amount * data.priceUsd;
                  if (
                    !t.symbol ||
                    t.symbol.length < 2 ||
                    t.symbol.includes("…")
                  ) {
                    t.symbol = data.symbol;
                  }
                  t.isKnown = true;
                  resolved += 1;
                }
                if (resolved > 0) {
                  live.sources.push({
                    name: "DEX Screener",
                    ok: true,
                    tokens: resolved,
                  });
                }
              } catch (e) {
                console.warn("DEX Screener fetch failed:", e);
              }
            }
          } else {
            console.warn(
              "EVM live state: all DeBank endpoints failed",
              tokensRes.status === "rejected" && tokensRes.reason,
              protocolsRes.status === "rejected" && protocolsRes.reason,
            );
          }
        } else if (wallet.chain === "sol" && ENABLE_NON_EVM_PROVIDERS) {
          // Solana: Helius — балансы SPL и история (для cost basis).
          //         Jupiter Price — цены mint'ов.
          //         CoinStats — PRIMARY для DeFi-позиций (самое широкое
          //         покрытие — Sanctum, Mango, Phoenix, Meteora, Tensor, и т.д.).
          //         Vybe / Jupiter Portfolio — fallback для протоколов,
          //         которых CoinStats не знает (Drift, MarginFi, Solend …).
          const sources: NonNullable<LiveSnapshot["sources"]> = [];
          try {
            const balances = await fetchHeliusBalances(
              { address: wallet.address, apiKey },
              ctrl.signal,
            );
            const mints = [SOL_NATIVE_MINT, ...balances.tokens.map((t) => t.mint)];
            const prices = await fetchJupiterPrices(mints, ctrl.signal);
            live = adaptSolanaLive({ wallet, balances, prices });
            sources.push({
              name: "Helius",
              ok: true,
              tokens: live.tokens.length,
            });
            sources.push({
              name: "Jupiter Price",
              ok: prices.size > 0,
              tokens: prices.size,
            });
            // Источник Shyft TX (parsed history) — был вызван выше в
            // classifier-ветке, результат сохранён в shyftTxResult.
            if (shyftTxResult) {
              sources.push({
                name: "Shyft TX",
                ok: shyftTxResult.ok,
                tokens: shyftTxResult.enriched ?? 0,
                ...(shyftTxResult.error
                  ? { error: shyftTxResult.error }
                  : {}),
              });
            }

            // Подтянем metadata для unknown токенов через Jupiter Token API
            // (раздельный endpoint от Price API). Позволяет распознать
            // символ/decimals/имя для свежих SPL-токенов которых нет в
            // нашем курируемом SPL_TOKENS списке.
            const unknownMints = live.tokens
              .filter((t) => !t.isKnown && t.amount > 0)
              .map((t) => t.tokenId);
            if (unknownMints.length > 0) {
              try {
                const metaMap = await fetchJupiterTokenMetaBatch(
                  unknownMints,
                  ctrl.signal,
                );
                let resolved = 0;
                for (const t of live.tokens) {
                  const meta = metaMap.get(t.tokenId);
                  if (!meta) continue;
                  t.symbol = meta.symbol;
                  t.isKnown = true;
                  resolved += 1;
                }
                if (resolved > 0) {
                  sources.push({
                    name: "Jupiter Token API",
                    ok: true,
                    tokens: resolved,
                  });
                }
              } catch (e) {
                console.warn("Jupiter Token API fetch failed:", e);
              }
            }

            // Shyft metadata fallback — после Jupiter Token API. Shyft
            // `/wallet/all_tokens` возвращает symbol/decimals/name/image
            // для всех SPL-токенов на кошельке. Покрытие шире чем
            // Jupiter Token API для нишевых mints.
            const shyftKeyForTokens = (integrations.shyftApiKey ?? "").trim();
            if (shyftKeyForTokens) {
              try {
                const shyftMeta = await fetchShyftTokenMeta({
                  address: wallet.address,
                  apiKey: shyftKeyForTokens,
                  signal: ctrl.signal,
                });
                let resolved = 0;
                for (const t of live.tokens) {
                  if (t.isKnown && t.symbol && !t.symbol.includes("…")) continue;
                  const meta = shyftMeta.get(t.tokenId);
                  if (!meta) continue;
                  if (meta.symbol) t.symbol = meta.symbol;
                  t.isKnown = true;
                  resolved += 1;
                }
                // Всегда показываем Shyft Tokens в источниках, даже если
                // 0 toкенов обогащено (это значит все уже были known и
                // Shyft просто проверил — это полезно знать).
                sources.push({
                  name: "Shyft Tokens",
                  ok: true,
                  tokens: resolved,
                });
              } catch (e) {
                if ((e as Error).name !== "AbortError") {
                  console.warn("Shyft tokens fetch failed:", e);
                  sources.push({
                    name: "Shyft Tokens",
                    ok: false,
                    error: (e as Error).message,
                  });
                }
              }
            } else {
              sources.push({
                name: "Shyft Tokens",
                ok: false,
                error: "no API key",
              });
            }

            // DEX Screener fallback — для tokens с amount > 0 но price = 0
            // (Jupiter Price их не котирует, обычно свежие или нишевые SPL).
            // DEX Screener возвращает цену из самого ликвидного DEX-пула.
            const noPriceMints = live.tokens
              .filter((t) => t.amount > 0 && (t.price == null || t.price <= 0))
              .map((t) => t.tokenId);
            if (noPriceMints.length > 0) {
              try {
                const priceMap = await fetchDexScreenerTokenBatch(
                  noPriceMints,
                  ctrl.signal,
                );
                let resolved = 0;
                for (const t of live.tokens) {
                  const data = priceMap.get(t.tokenId);
                  if (!data) continue;
                  t.price = data.priceUsd;
                  t.usd = t.amount * data.priceUsd;
                  // Если symbol всё ещё похож на raw mint, обновим из DEX.
                  if (
                    !t.symbol ||
                    t.symbol.length < 2 ||
                    t.symbol.includes("…")
                  ) {
                    t.symbol = data.symbol;
                  }
                  t.isKnown = true;
                  resolved += 1;
                }
                if (resolved > 0) {
                  sources.push({
                    name: "DEX Screener",
                    ok: true,
                    tokens: resolved,
                  });
                }
              } catch (e) {
                console.warn("DEX Screener fetch failed:", e);
              }
            }

            // 1) CoinStats — PRIMARY: ставим первым, его данные считаются
            // авторитетными для пересекающихся протоколов.
            const coinstatsKey = (integrations.coinstatsApiKey ?? "").trim();
            if (coinstatsKey) {
              try {
                const [csBalance, csDefi] = await Promise.all([
                  fetchCoinStatsBalance({
                    address: wallet.address,
                    connectionId: "solana",
                    apiKey: coinstatsKey,
                  }),
                  fetchCoinStatsDefi({
                    address: wallet.address,
                    connectionId: "solana",
                    apiKey: coinstatsKey,
                  }).catch(() => ({
                    totalAssets: { USD: 0, BTC: 0, ETH: 0 },
                    protocols: [],
                  })),
                ]);
                const csLive = adaptCoinStatsLive({
                  wallet,
                  connectionId: "solana",
                  balance: csBalance,
                  defi: csDefi,
                });
                // Tokens: дедуп по symbol — Helius уже дал базу, CoinStats
                // только добавляет неизвестные / fixит цену если Jupiter упал.
                const existingBySymbol = new Map(
                  live.tokens.map((t) => [t.symbol.toUpperCase(), t]),
                );
                for (const cs of csLive.tokens) {
                  const sym = cs.symbol.toUpperCase();
                  const ex = existingBySymbol.get(sym);
                  if (ex) {
                    if ((ex.price ?? 0) <= 0 && cs.price) {
                      ex.price = cs.price;
                      ex.usd = ex.amount * cs.price;
                    }
                  } else {
                    cs.chain = "sol";
                    live.tokens.push(cs);
                    existingBySymbol.set(sym, cs);
                  }
                }
                // Positions: CoinStats — primary, ставим целиком (live.positions
                // ещё пуст — Jupiter Portfolio и Vybe идут ниже).
                if (csLive.positions.length > 0) {
                  live.positions = mergeVybeIntoLive(
                    live.positions,
                    csLive.positions,
                  );
                }
                sources.push({
                  name: "CoinStats",
                  ok: true,
                  tokens: csLive.tokens.length,
                  positions: csLive.positions.length,
                });
              } catch (e) {
                console.warn("CoinStats Solana fetch failed:", e);
                sources.push({
                  name: "CoinStats",
                  ok: false,
                  error: (e as Error).message,
                });
              }
            } else {
              sources.push({
                name: "CoinStats",
                ok: false,
                error: "no API key",
              });
            }

            // 2) Jupiter Portfolio — FALLBACK: добавляет только те протоколы,
            // которые ещё не пришли из CoinStats. Раньше Jupiter перезаписывал
            // CoinStats и затем сам мог быть стёрт Vybe — теряли богатые данные.
            const jupKey = (integrations.jupiterApiKey ?? "").trim();
            if (jupKey) {
              try {
                const jupRes = await fetchJupiterPortfolio(
                  { address: wallet.address, apiKey: jupKey },
                  ctrl.signal,
                );
                if (jupRes) {
                  const jupPositions = adaptJupiterPortfolioLive({ wallet, portfolio: jupRes });
                  if (jupPositions.length > 0) {
                    live.positions = appendIfMissing(live.positions, jupPositions);
                  }
                  sources.push({
                    name: "Jupiter Portfolio",
                    ok: true,
                    positions: jupPositions.length,
                  });
                } else {
                  sources.push({
                    name: "Jupiter Portfolio",
                    ok: false,
                    error: "empty response",
                  });
                }
              } catch (e) {
                console.warn("Jupiter Portfolio fetch failed:", e);
                sources.push({
                  name: "Jupiter Portfolio",
                  ok: false,
                  error: (e as Error).message,
                });
              }
            } else {
              sources.push({
                name: "Jupiter Portfolio",
                ok: false,
                error: "no API key",
              });
            }

            // 3) Vybe — FALLBACK: добавляет Drift / MarginFi / Solend если
            // CoinStats и Jupiter Portfolio их не вернули.
            const vybeKey = integrations.vybeApiKey.trim();
            if (vybeKey) {
              try {
                const vybe = await fetchVybeDefiPositions(
                  { address: wallet.address, apiKey: vybeKey },
                  ctrl.signal,
                );
                const vybePositions = adaptVybeLive({ wallet, vybe });
                live.positions = appendIfMissing(live.positions, vybePositions);
                sources.push({
                  name: "Vybe Network",
                  ok: true,
                  positions: vybePositions.length,
                });
              } catch (e) {
                console.warn("Vybe positions fetch failed:", e);
                sources.push({
                  name: "Vybe Network",
                  ok: false,
                  error: (e as Error).message,
                });
              }
            } else {
              sources.push({
                name: "Vybe Network",
                ok: false,
                error: "no API key",
              });
            }

            live.totalUsd =
              live.tokens.reduce((s, t) => s + t.usd, 0) +
              live.positions.reduce((s, p) => s + p.netUsd, 0);
            live.sources = sources;
          } catch (e) {
            console.warn("Solana live state fetch failed:", e);
          }
        } else if (
          wallet.chain === "coinstats" &&
          wallet.connectionId &&
          ENABLE_NON_EVM_PROVIDERS
        ) {
          // CoinStats live: balance + defi за один запрос каждый.
          try {
            const [balance, defi] = await Promise.all([
              fetchCoinStatsBalance({
                address: wallet.address,
                connectionId: wallet.connectionId,
                apiKey,
              }),
              fetchCoinStatsDefi({
                address: wallet.address,
                connectionId: wallet.connectionId,
                apiKey,
              }).catch(() => ({
                totalAssets: { USD: 0, BTC: 0, ETH: 0 },
                protocols: [],
              })),
            ]);
            live = adaptCoinStatsLive({
              wallet,
              connectionId: wallet.connectionId,
              balance,
              defi,
            });
            live.sources = [
              {
                name: "CoinStats",
                ok: true,
                tokens: live.tokens.length,
                positions: live.positions.length,
              },
            ];
          } catch (e) {
            console.warn("CoinStats live state fetch failed:", e);
          }
        }

        // Cost basis в LiveTokenBalance — связываем с историей.
        if (live) {
          enrichTokensWithCostBasis(live.tokens, snapshot);
        }

        const payload: Loaded = {
          wallet,
          ops,
          snapshot,
          loadedAt: Date.now(),
        };
        if (live) payload.live = live;
        // Полнота истории (EVM/DeBank). Сохраняем в payload+кэш, чтобы
        // следующая загрузка выбрала инкремент вместо полного бэкфилла.
        if (historyComplete !== undefined) {
          payload.historyComplete = historyComplete;
        }
        setLoadedById((prev) => ({ ...prev, [wallet.id]: payload }));
        // Персистентный кэш: при следующем заходе данные подтянутся без API.
        // Explore-кошельки (id `explore::…`) — НЕ кэшируем: это разовая
        // разведка чужого адреса, которая не должна попадать в дашборд при
        // следующем открытии.
        if (!wallet.id.startsWith("explore::")) {
          writeWalletCache(wallet.id, payload);
          // UCB B5.3: fire-and-forget push ops в server-side cache. Это
          // backup для cross-device access и foundation для server-side
          // primary cache в Phase 2 (server reading instead of DeBank
          // на каждый reload). Errors silently swallowed — client cache
          // всё ещё работает как до B5.
          pushOpsToServer(wallet.id, ops).catch((e) => {
            console.warn(
              `[chain-ops] backup to server failed for ${wallet.id}:`,
              (e as Error).message,
            );
          });
        }
        return payload;
      } catch (e) {
        if ((e as Error).name === "AbortError") return null;
        setError((e as Error).message || "Request error");
        return null;
      } finally {
        setBusyId(null);
        setProgress(null);
        // Освобождаем abortRef ТОЛЬКО если это всё ещё наш контроллер.
        // Если уже стартовал следующий load — он уже перетёр ref своим ctrl,
        // не трогаем чужой. Без этого сброса auto-refresh ниже видит truthy
        // ref навсегда и больше никогда не запускается.
        if (abortRef.current === ctrl) {
          abortRef.current = null;
        }
      }
    },
    [keyFor, wallets.list],
  );

  const loadAll = useCallback(
    async (options?: { full?: boolean }) => {
      // PR-K4: «Обновить» инвалидирует ВСЕ external-source кеши, не только
      // DeBank wallet snapshots. Krystal V3 positions cache (24h TTL) — иначе
      // юзер ткнул refresh, ожидает свежее, но Krystal данные остаются stale
      // до истечения 24h.
      try {
        const { clearAllKrystalCache } = await import("@/lib/krystal/cache");
        clearAllKrystalCache();
      } catch {
        /* cache module optional, ignore */
      }
      for (const w of wallets.list) {
        // Не пропускаем уже загруженные — для них сделаем incremental.
        if (!keyFor(w.chain)) continue;
        await load(w, options);
      }
    },
    [wallets.list, keyFor, load],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setBusyId(null);
  }, []);

  // Авто-обновление кошельков — ТОЛЬКО когда пользователь реально в сервисе.
  //
  // Раньше: слепой setInterval раз в час крутился всегда, даже для свёрнутой
  // вкладки / offline / неактивного юзера → жёг DeBank-кредиты впустую.
  //
  // Теперь: рефреш срабатывает по «возврату в сервис» (вкладка снова видима,
  // фокус окна, восстановление сети) + лёгкий 5-мин тик как будильник. Каждый
  // триггер проходит через `maybeRefresh`, который гейтит:
  //   • вкладка должна быть видима (`visibilityState==='visible'`);
  //   • online (`navigator.onLine`);
  //   • не идёт другая загрузка (`abortRef`);
  //   • прошло ≥ autoRefreshMinIntervalMs с последнего обновления.
  // Анкер троттлинга = самый свежий `loadedAt` среди кошельков (или штамп
  // последней попытки) → естественно не чаще 1/час и без рефреша на свежем
  // кэше при простом reload. «Обновить» вручную — отдельный path (loadAll).
  const loadAllRef = useRef(loadAll);
  loadAllRef.current = loadAll;
  const loadedByIdRef = useRef(loadedById);
  loadedByIdRef.current = loadedById;
  const lastAutoRefreshRef = useRef<number>(0);
  useEffect(() => {
    if (wallets.list.length === 0) return;

    const maybeRefresh = () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      ) {
        return; // вкладка скрыта — юзер не в сервисе
      }
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        return; // offline — нет смысла
      }
      if (abortRef.current) return; // загрузка уже идёт
      const loaded = Object.values(loadedByIdRef.current);
      if (loaded.length === 0) return; // первичную загрузку делает bootstrap
      const freshest = Math.max(
        lastAutoRefreshRef.current,
        ...loaded.map((l) => l.loadedAt),
      );
      const minInterval = appConfigRef.current.autoRefreshMinIntervalMs;
      if (Date.now() - freshest < minInterval) return; // ещё рано
      // Штампуем попытку ДО запуска — чтобы при сбое не ретраить каждый тик.
      lastAutoRefreshRef.current = Date.now();
      void loadAllRef.current();
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") maybeRefresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", maybeRefresh);
    window.addEventListener("online", maybeRefresh);
    // Будильник раз в 5 минут: сам гейтит по visibility + min-interval, так что
    // реальный рефреш — не чаще раза в час и только для видимой вкладки.
    const interval = window.setInterval(maybeRefresh, 5 * 60 * 1000);
    // Проверка при входе в сервис (вдруг кэш уже устарел > min-interval).
    maybeRefresh();

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", maybeRefresh);
      window.removeEventListener("online", maybeRefresh);
      window.clearInterval(interval);
    };
  }, [wallets.list.length]);

  const forget = useCallback((walletId: string) => {
    deleteWalletCache(walletId);
    setLoadedById((prev) => {
      const c = { ...prev };
      delete c[walletId];
      return c;
    });
  }, []);

  const forgetAll = useCallback(() => {
    for (const id of readAllWalletCacheIds()) deleteWalletCache(id);
    setLoadedById({});
  }, []);

  // Bootstrap ref must exist before the auth-switch effect below so
  // that effect can reset it on identity change.
  const bootstrappedRef = useRef(false);

  // Prune loadedById to whatever wallets.list currently contains. The
  // wallet cache (capflow.cache.v6.wallet.<wid>) is keyed by wallet
  // UUID and survives across user switches — without this filter, an
  // admin who loaded vitalik's wallet would leak vitalik's ops to
  // Alice's dashboard the moment Alice's page rehydrated from cache.
  // Hydration scopes wallets.list per current user, so the
  // intersection here is the right user-isolation boundary.
  useEffect(() => {
    const currentIds = new Set(wallets.list.map((w) => w.id));
    setLoadedById((prev) => {
      let changed = false;
      const next: Record<string, Loaded> = {};
      for (const [id, payload] of Object.entries(prev)) {
        if (currentIds.has(id)) {
          next[id] = payload;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [wallets.list]);

  // When the auth subject switches (admin starts/stops impersonating
  // another user, or a different user logs in on the same browser),
  // every piece of in-memory state belongs to the previous identity.
  // Hard-reset everything so Bob can't see Vladimir's loaded wallets,
  // and so the bootstrap effect below re-runs against the new user's
  // wallet list.
  //
  // ALSO does first-mount cache hydration here (after setCacheUserScope
  // is called) — see comment on the useState declaration above for why
  // we can't hydrate in the initializer.
  const lastUserIdRef = useRef<string | null>(null);
  useEffect(() => {
    const id = user?.id ?? null;
    // Set per-user cache scope BEFORE any read/write — all wallet-cache
    // functions short-circuit when no scope is set.
    setCacheUserScope(id);
    const isUserSwitch =
      lastUserIdRef.current !== null && lastUserIdRef.current !== id;
    if (isUserSwitch) {
      // Drop previous user's data so Bob can't see Vladimir's wallets.
      for (const cid of readAllWalletCacheIds()) deleteWalletCache(cid);
      setLoadedById({});
      bootstrappedRef.current = false;
      setHydrationDone(false);
    }
    lastUserIdRef.current = id;
    // Hydrate from localStorage now that scope is set. Skip when no
    // user (logged out) — there's nothing to read with no scope.
    if (id !== null && !hydrationDone) {
      const currentIds = new Set(wallets.list.map((w) => w.id));
      const restored: Record<string, Loaded> = {};
      for (const cid of readAllWalletCacheIds()) {
        if (!currentIds.has(cid)) {
          // Orphan cache entry from a previous user / removed wallet.
          deleteWalletCache(cid);
          continue;
        }
        const v = readWalletCache<Loaded>(cid);
        if (v) restored[cid] = v;
      }
      if (Object.keys(restored).length > 0) {
        setLoadedById((prev) => ({ ...restored, ...prev }));
      }
      // Mark hydrated only after we've seen at least one wallet — if
      // wallets.list is still empty (server hydration in flight), wait
      // for it before allowing bootstrap to fire. Without this guard
      // bootstrap would run on the empty list, decide "nothing to do",
      // and then never get a chance to use the cache once wallets arrive.
      if (wallets.list.length > 0) {
        setHydrationDone(true);
      }
    }
  }, [user?.id, wallets.list, hydrationDone]);

  // Bootstrap: автоматически грузим только те кошельки, для которых нет кэша.
  // Если все уже в кэше — не делаем НИ ОДНОГО запроса.
  //
  // CRITICAL: ждём `hydrationDone` — иначе bootstrap бы запустился
  // против пустого `loadedById` (initial state), даже если кэш в
  // localStorage есть, и сжёг бы DeBank-кредиты на каждый reload.
  useEffect(() => {
    if (!hydrationDone) return;
    if (bootstrappedRef.current) return;
    if (wallets.list.length === 0) return;
    bootstrappedRef.current = true;
    // Грузим в фоне только новые кошельки (которых нет в кэше).
    const missing = wallets.list.filter((w) => !loadedById[w.id]);
    if (missing.length === 0) return;
    void (async () => {
      for (const w of missing) {
        if (!keyFor(w.chain)) continue;
        // UCB B5.3 Phase 2: пробуем server-side primary cache ДО DeBank
        // pull. На fresh devices (или после `localStorage.clear()`) это
        // даёт мгновенную гидратацию без жжения DeBank-кредитов.
        // Errors silently swallowed — fall through к full `load()`.
        const fromServer = await tryHydrateFromServer(w).catch(() => null);
        if (fromServer) {
          setLoadedById((prev) =>
            prev[w.id] ? prev : { ...prev, [w.id]: fromServer },
          );
          // Кэшируем server-полученные ops в localStorage чтобы следующий
          // reload был оффлайн-фастом без любого network round-trip.
          if (!w.id.startsWith("explore::")) writeWalletCache(w.id, fromServer);
          continue;
        }
        await load(w);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallets.list, hydrationDone]);

  // UCB A1: server-side same-chain self-transfer pairs (Layer 1 — exact
  // tx_hash match через chain_operations table). Загружается параллельно
  // с client-side detector'ом, мерж'ится ниже. Подтягивается ТОЛЬКО когда
  // user logged in и есть хотя бы 2 wallet'а — иначе нет смысла querying.
  const graphQuery = useGraphInternalTransfers(
    !!user?.id && wallets.list.length >= 2,
  );
  const serverInternalPairs = graphQuery.data?.pairs ?? [];
  const serverCrossChainPairs = graphQuery.data?.crossChainPairs ?? [];

  // UCB A3: user annotations — per-op overrides classifier'а / pair detector'а.
  // Загружаем bulk + кэшируем 1min (мутации invalidate'ят). Применяем
  // к `internalHashes` ниже и к `manualOpType`/`manualCostBasisUsd` —
  // в downstream cost-basis pipeline (опциональная фича).
  const annotationsQuery = useAnnotations(!!user?.id);
  const annotations = annotationsQuery.data?.annotations ?? [];

  // UCB D3: server-derived CEX inheritance cost basis per tx_hash.
  // P2P fiat → trades → withdrawal → on-chain transfer_in: server считает
  // WAC через всю CEX-цепочку и отдаёт `costBasisUsd` для каждого tx_hash.
  // Эти данные feed'аются в LotTracker как cost basis override (handlers
  // используют их вместо derived market price), что фиксит cost basis
  // для всех downstream lending/LP позиций (POS-007 WBTC и т.п.).
  const cexCostBasisQ = useCexWithdrawalCostBasis();
  const cexCostBasisByHash = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cexCostBasisQ.data ?? []) {
      if (c.costBasisUsd > 0) {
        m.set(c.txHash.toLowerCase(), c.costBasisUsd);
      }
    }
    return m;
  }, [cexCostBasisQ.data]);

  // Cross-wallet detection: пары internal-transfers между своими кошельками.
  // Пересчитывается мгновенно при любом изменении loadedById.
  //
  // Стратегия мержа с A1 server pairs:
  //   1. Server pairs (Layer 1: exact tx_hash) — DETERMINISTIC, добавляем
  //      первыми. Они работают cross-device — даже если client cache
  //      хранит только один из двух wallets, server знает оба.
  //   2. Client heuristic (Layer 2: time+amount fuzzy) — ловит cross-chain
  //      bridges. Добавляем сверху, исключая hashes уже найденные L1.
  const internalPairs = useMemo(() => {
    const merged: import("@/lib/portfolio/internal_transfers").InternalPair[] = [];
    const seenHashes = new Set<string>();

    // L1: server-side exact tx_hash pairs. Из `raw` восстанавливаем
    // movement.amount / symbol для UI markers.
    for (const p of serverInternalPairs) {
      const outRaw = p.outRaw as ClassifiedOp | null;
      const inRaw = p.inRaw as ClassifiedOp | null;
      if (!outRaw || !inRaw) continue;
      // Найдём первое out- и in-movement подходящих знаков
      const outMov = outRaw.movement?.find((m) => m.direction === "out");
      const inMov = inRaw.movement?.find((m) => m.direction === "in");
      if (!outMov || !inMov) continue;
      merged.push({
        outHash: p.txHash,
        inHash: p.txHash, // L1: один и тот же tx_hash on both sides
        symbol: outMov.symbol,
        outAmount: outMov.amount,
        inAmount: inMov.amount,
        fromWalletId: p.outWalletId,
        toWalletId: p.inWalletId,
        feeApprox: 0, // L1 same-chain → fee уже в gas, не в delta amount
      });
      seenHashes.add(p.txHash);
    }

    // L2 server (UCB A2): cross-chain fuzzy match через server `chain_operations`.
    // Работает кросс-девайсно и не зависит от того, какие wallets гидратированы
    // в текущей сессии. Преимущество перед client-heuristic — отрабатывает
    // ДО первого browser-side `findInternalTransferPairs` запуска.
    for (const p of serverCrossChainPairs) {
      if (seenHashes.has(p.outTxHash) || seenHashes.has(p.inTxHash)) continue;
      merged.push({
        outHash: p.outTxHash,
        inHash: p.inTxHash,
        symbol: p.symbol,
        outAmount: p.outAmount,
        inAmount: p.inAmount,
        fromWalletId: p.outWalletId,
        toWalletId: p.inWalletId,
        feeApprox: p.feeUsd,
      });
      seenHashes.add(p.outTxHash);
      seenHashes.add(p.inTxHash);
    }

    // L2 client fallback: client heuristic для wallets / ops, которые
    // ещё не попали на сервер (свежий load до того как Phase 1 push
    // завершился). Skip pairs уже найденные server-side.
    const items: { op: ClassifiedOp; walletId: string }[] = [];
    for (const id of Object.keys(loadedById)) {
      const l = loadedById[id]!;
      for (const op of l.ops) items.push({ op, walletId: l.wallet.id });
    }
    if (items.length > 0) {
      const localPairs = findInternalTransferPairs(items).pairs;
      for (const p of localPairs) {
        if (seenHashes.has(p.outHash) || seenHashes.has(p.inHash)) continue;
        merged.push(p);
      }
    }

    return merged;
  }, [loadedById, serverInternalPairs, serverCrossChainPairs]);

  const internalHashes = useMemo(() => {
    const set = new Set<string>();
    for (const p of internalPairs) {
      set.add(p.outHash);
      set.add(p.inHash);
    }
    // UCB A3: применяем user annotations поверх detector'а:
    //   - `isInternalTransfer === true`  → ДОБАВЛЯЕМ op в set (override "no")
    //   - `isInternalTransfer === false` → УДАЛЯЕМ op из set (override "yes")
    //   - null/undefined → не трогаем (detector управляет)
    for (const a of annotations) {
      if (a.isInternalTransfer === true) set.add(a.txHash);
      else if (a.isInternalTransfer === false) set.delete(a.txHash);
    }
    return set;
  }, [internalPairs, annotations]);

  // UCB A4: composite-key map для apply_annotations. Composite frontend
  // wallet id (`api:<walletId>:<addressId>`) → wallet UUID; матчинг с
  // resolved annotations идёт по wallet UUID.
  const annotationsByKey = useMemo(() => {
    const m = new Map<string, import("@/features/chain-ops/api").ResolvedAnnotation>();
    for (const a of annotations) {
      m.set(`${a.walletId}|${a.txHash.toLowerCase()}|${a.logIndex}`, a);
    }
    return m;
  }, [annotations]);

  // UCB C2: fiat-hop cost basis inheritance — закрывает gap для
  // on-chain → CEX → on-chain циклов (withdraw_fiat ↔ deposit_fiat pairs).
  // Существующий A2 internal-transfer matcher skip'аeт same-wallet и
  // не propagate cost basis в любом случае. CEX D3 покрывает только
  // случаи когда у user'а подключен CEX account. C2 — local pure-function
  // детектор для всех остальных случаев.
  //
  // Priority при merge:
  //   A4 manual (runUcbPipelineForWallet) > D3 CEX (server) > C2 fiat-hop (local).
  // Server-validated CEX inheritance бьёт local heuristic; manual бьёт всё.
  const opsByWalletForInheritance = useMemo(() => {
    const m = new Map<string, ClassifiedOp[]>();
    for (const id of Object.keys(loadedById)) {
      const l = loadedById[id]!;
      const realWalletId = l.wallet.id.startsWith("api:")
        ? (l.wallet.id.split(":")[1] ?? l.wallet.id)
        : l.wallet.id;
      m.set(realWalletId, l.ops);
    }
    return m;
  }, [loadedById]);

  const fiatHopCostBasisByHash = useMemo(
    () =>
      computeFiatHopCostBasisOverrides(
        opsByWalletForInheritance,
        cexCostBasisByHash,
      ),
    [opsByWalletForInheritance, cexCostBasisByHash],
  );

  // UCB C3: cross-wallet transfer/bridge inheritance — закрывает gap для
  // direct on-chain transfers без CEX (EOA→EOA, незаклассифицированные
  // bridges). Same-wallet skip (D5 + C2 покрывают). Принимает уже
  // вычисленные C2 + D3 overrides как preExisting → multi-source chain
  // inheritance работает.
  const crossWalletCostBasisByHash = useMemo(() => {
    const preExisting = new Map<string, number>(fiatHopCostBasisByHash);
    for (const [k, v] of cexCostBasisByHash) preExisting.set(k, v);
    return computeCrossWalletCostBasisOverrides(
      opsByWalletForInheritance,
      preExisting,
    );
  }, [opsByWalletForInheritance, fiatHopCostBasisByHash, cexCostBasisByHash]);

  const mergedCostBasisByHash = useMemo(() => {
    // Priority order (lowest → highest):
    //   C3 cross-wallet < C2 fiat-hop < D3 CEX (server) < A4 manual (runUcb...)
    const m = new Map<string, number>(crossWalletCostBasisByHash);
    for (const [k, v] of fiatHopCostBasisByHash) m.set(k, v);
    for (const [k, v] of cexCostBasisByHash) m.set(k, v);
    return m;
  }, [crossWalletCostBasisByHash, fiatHopCostBasisByHash, cexCostBasisByHash]);

  // UCB C5.4: per-wallet lot+position trackers через orchestrator.
  // Раньше эта useMemo сама делала applyAnnotations → merge cost-basis →
  // buildLotsAndPositions. Теперь весь pipeline за `runUcbPipelineForWallet`
  // (single source of truth с D8 / A3 / A4 / D3 / C2 / D5 invariants).
  const newTrackers = useMemo(() => {
    const lotsByWallet = new Map<string, LotTracker>();
    const positionsByWallet = new Map<string, PositionTracker>();
    const walletNameById = new Map<string, string>();
    for (const id of Object.keys(loadedById)) {
      walletNameById.set(id, loadedById[id]!.wallet.name);
    }
    for (const id of Object.keys(loadedById)) {
      const l = loadedById[id]!;
      // Composite frontend id (api:<uuid>:<address>) → wallet UUID для
      // annotation matching. Lot/Position trackers keyed по composite id.
      const realWalletId = l.wallet.id.startsWith("api:")
        ? (l.wallet.id.split(":")[1] ?? l.wallet.id)
        : l.wallet.id;
      try {
        const result = runUcbPipelineForWallet({
          walletId: l.wallet.id,
          walletIdForAnnotations: realWalletId,
          ops: l.ops,
          annotationsByKey,
          costBasisOverrideByHash: mergedCostBasisByHash,
          resolvedAnnotations: annotations,
          walletNameById,
        });
        lotsByWallet.set(l.wallet.id, result.lotTracker);
        if (result.positionTracker) {
          positionsByWallet.set(l.wallet.id, result.positionTracker);
        }
      } catch (err) {
        console.warn(`[newTrackers] failed for wallet ${id}:`, err);
      }
    }
    // Expose `window.capflowCompareTrackers()` для browser console
    // верификации (Этап 12 / Шаг B).
    if (typeof window !== "undefined") {
      (
        window as unknown as { capflowCompareTrackers: () => unknown }
      ).capflowCompareTrackers = () => {
        // Lazy import — избегаем dependency loop.
        return import("@/lib/portfolio/positions").then((mod) =>
          mod.generateComparisonReport(
            lotsByWallet,
            positionsByWallet,
            walletNameById,
          ),
        );
      };
    }
    return { lotsByWallet, positionsByWallet };
  }, [loadedById, annotationsByKey, mergedCostBasisByHash, annotations]);

  // ─── UCB C1: auto-upload deposit seeds ──────────────────────────────
  // После того как `newTrackers` готов И мы знаем CEX deposit hashes —
  // считаем cost basis для каждого matching transfer_out и батчем POSTим
  // на server. Server использует их в `applyDeposit` чтобы CEX-side
  // pool получил правильный cost basis вместо $0 / amount.
  //
  // Debounced 3s чтобы не штамповать requests на каждый рerender. Idempotent:
  // повторный POST с теми же hash перезаписывает row через ON CONFLICT.
  const cexTransfersQ = useCexTransfersWithHash();
  const upsertSeeds = useUpsertDepositSeeds();
  const cexDepositHashes = useMemo(() => {
    const s = new Set<string>();
    for (const t of cexTransfersQ.data ?? []) {
      if (t.direction === "deposit" && t.txHash) {
        s.add(t.txHash.toLowerCase());
      }
    }
    return s;
  }, [cexTransfersQ.data]);

  useEffect(() => {
    if (cexDepositHashes.size === 0) return;
    if (Object.keys(loadedById).length === 0) return;
    // Debounce — wait for stable data before posting.
    const tm = window.setTimeout(() => {
      const allSeeds: Array<{
        txHash: string;
        chain: string;
        costBasisUsd: number;
        walletId: string | null;
        note: string | null;
      }> = [];
      for (const l of Object.values(loadedById)) {
        const realWalletId = l.wallet.id.startsWith("api:")
          ? (l.wallet.id.split(":")[1] ?? l.wallet.id)
          : l.wallet.id;
        const tracker = newTrackers.lotsByWallet.get(l.wallet.id);
        if (!tracker) continue;
        const chain =
          l.wallet.chain === "coinstats" ? "eth" : l.wallet.chain;
        const seeds = computeDepositSeedsFromOps(
          l.ops,
          l.wallet.id,
          chain,
          tracker,
          cexDepositHashes,
        );
        // Override walletId с real UUID (server uses it for provenance link).
        for (const s of seeds) {
          allSeeds.push({ ...s, walletId: realWalletId });
        }
      }
      if (allSeeds.length === 0) return;
      // Fire-and-forget; на error UI не блокируется (worst case — cost
      // basis fallback на legacy).
      upsertSeeds.mutate(allSeeds);
    }, 3000);
    return () => window.clearTimeout(tm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedById, cexDepositHashes, newTrackers.lotsByWallet]);

  const value = useMemo<Ctx>(
    () => ({
      loadedById,
      busyId,
      progress,
      error,
      load,
      loadAll,
      cancel,
      clearError: () => setError(null),
      forget,
      forgetAll,
      internalPairs,
      internalHashes,
      newTrackers,
      annotationsByKey,
      costBasisOverrideByHash: mergedCostBasisByHash,
    }),
    [
      loadedById,
      busyId,
      progress,
      error,
      load,
      loadAll,
      cancel,
      forget,
      forgetAll,
      internalPairs,
      internalHashes,
      newTrackers,
      annotationsByKey,
      mergedCostBasisByHash,
    ],
  );

  return <LoadedCtx.Provider value={value}>{children}</LoadedCtx.Provider>;
}

export function useLoadedWallets(): Ctx {
  const ctx = useContext(LoadedCtx);
  if (!ctx)
    throw new Error("useLoadedWallets must be used inside <LoadedWalletsProvider>");
  return ctx;
}

/* ------------------------------ helpers ----------------------------------- */

import type { LiveProtocolPosition, LiveTokenBalance } from "@/lib/portfolio/live";

/**
 * Сливает старые и новые ops, дедуплицируя по `chain:hash`.
 * Новые tx по определению свежее, поэтому если хэш уже есть — оставляем
 * новый (на случай, если он был "pending" и обновился).
 *
 * После merge пересчитываем sequential `seq` по возрастанию времени.
 */
function mergeOps(oldOps: ClassifiedOp[], newOps: ClassifiedOp[]): ClassifiedOp[] {
  const map = new Map<string, ClassifiedOp>();
  for (const o of oldOps) map.set(`${o.chain}:${o.hash}`, o);
  for (const o of newOps) map.set(`${o.chain}:${o.hash}`, o); // overwrite
  const merged = Array.from(map.values()).sort((a, b) => a.time - b.time);
  for (let i = 0; i < merged.length; i++) merged[i]!.seq = i + 1;
  return merged;
}

/**
 * Объединяет позиции из разных источников (Helius/Jupiter/Vybe/CoinStats).
 * Новый источник перезаписывает старый, если найдено совпадение по
 * нормализованному имени протокола.
 *
 * Раньше дедуп шёл через `protocolName.toLowerCase()` — это даёт двойной учёт
 * на синонимах: "Kamino Lend" (Vybe) ≠ "Kamino Finance" (CoinStats) ≠
 * "Kamino" (Jupiter). Теперь нормализуем: убираем общие суффиксы
 * ("finance", "protocol", "lend", …), оставляем версионность ("aave_v3").
 */
const PROTOCOL_NAME_SUFFIX_NOISE = new Set([
  "finance",
  "protocol",
  "network",
  "labs",
  "io",
  "fi",
  "dao",
  "lend",
  "lending",
  "borrow",
]);

function normalizeProtocolName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^\w\s]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !PROTOCOL_NAME_SUFFIX_NOISE.has(w));
  return cleaned.length > 0 ? cleaned.join("_") : name.toLowerCase().trim();
}

function mergeVybeIntoLive(
  existing: LiveProtocolPosition[],
  vybe: LiveProtocolPosition[],
): LiveProtocolPosition[] {
  if (vybe.length === 0) return existing;
  const vybeNorm = new Set(vybe.map((p) => normalizeProtocolName(p.protocolName)));
  const filtered = existing.filter(
    (p) => !vybeNorm.has(normalizeProtocolName(p.protocolName)),
  );
  return [...filtered, ...vybe];
}

/**
 * Дополняет existing только теми позициями из addition, имени которых ещё
 * НЕТ в existing (по нормализованному имени). В отличие от mergeVybeIntoLive
 * не перезаписывает — existing считается авторитетным.
 *
 * Используется когда CoinStats — primary источник Solana DeFi, а Vybe /
 * Jupiter Portfolio только добавляют те протоколы, которых CoinStats не знает.
 */
function appendIfMissing(
  existing: LiveProtocolPosition[],
  addition: LiveProtocolPosition[],
): LiveProtocolPosition[] {
  if (addition.length === 0) return existing;
  const existingNorm = new Set(
    existing.map((p) => normalizeProtocolName(p.protocolName)),
  );
  const newOnly = addition.filter(
    (p) => !existingNorm.has(normalizeProtocolName(p.protocolName)),
  );
  return [...existing, ...newOnly];
}

/**
 * Доливает cost basis (по средневзвешенной из истории) и считает PnL.
 *
 * Связь между «токеном из live» и «токеном из истории»:
 *   - EVM: tokens[i].id (DeBank token id) ≈ snapshot.walletBalances[].tokenId
 *   - SOL: tokens[i].mint = snapshot.walletBalances[].tokenId
 *
 * Когда не нашли по tokenId, fallback по symbol+chain (символ + первые буквы
 * пути из reducer'а).
 */
export function enrichTokensWithCostBasis(
  tokens: LiveTokenBalance[],
  snapshot: { walletBalances: { symbol: string; tokenId: string; amount: number; costBasisUsd: number }[] },
): void {
  for (const tk of tokens) {
    let line = snapshot.walletBalances.find((b) => b.tokenId === tk.tokenId);
    if (!line) line = snapshot.walletBalances.find((b) => b.symbol === tk.symbol);
    if (!line || line.amount <= 0 || line.costBasisUsd <= 0) continue;

    const avg = line.costBasisUsd / line.amount;
    // Если live-кол-во отличается от исторического (часто), используем live amount × avg.
    const costBasisUsd = avg * tk.amount;
    const pnlUsd = tk.usd - costBasisUsd;
    const pnlPct = costBasisUsd > 0 ? (pnlUsd / costBasisUsd) * 100 : 0;

    tk.costBasisAvg = avg;
    tk.costBasisUsd = costBasisUsd;
    tk.pnlUsd = pnlUsd;
    tk.pnlPct = pnlPct;
  }
}

/**
 * UCB B5.3: батчевый push classified ops в server-side cache.
 *
 * Конвертирует `ClassifiedOp` (client shape) → `ChainOpInput` (transport
 * shape для `POST /v1/chain-ops/:walletId/sync`). Каждый op идёт с
 * `raw` = весь ClassifiedOp как frozen snapshot для server-side
 * re-replay (graph traversal в этапе A1, orchestrator C5).
 *
 * Большие batches (>2000) разбиваются — у server max validation = 10000,
 * но network/JSON-parse overhead заметный. 2000 — sweet spot для
 * payload-size vs round-trips.
 */
const SYNC_BATCH_SIZE = 2_000;

async function pushOpsToServer(
  compositeId: string,
  ops: readonly { hash: string; chain: string; time: number; type: string; status: string }[],
): Promise<void> {
  if (ops.length === 0) return;

  // Frontend wallet ids are composite: `api:<walletId>:<addressId>` (см.
  // useWalletsHydration.ts). Server `wallet_id` FK = `wallets(id)`, поэтому
  // вытаскиваем walletId — это второй сегмент. Explore-wallets (`explore::…`)
  // и legacy non-`api:` ids уже отфильтрованы на стороне caller'а, но на
  // всякий случай проверяем формат.
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let walletId: string;
  if (compositeId.startsWith("api:")) {
    const parts = compositeId.split(":");
    if (parts.length < 2) return;
    walletId = parts[1] ?? "";
  } else {
    walletId = compositeId;
  }
  if (!uuidRe.test(walletId)) return;

  const inputs: ChainOpInput[] = ops.map((op) => ({
    chain: op.chain,
    txHash: op.hash,
    logIndex: 0,
    opType: op.type,
    opTime: Math.floor(op.time),
    status: op.status || "ok",
    raw: op,
  }));

  for (let i = 0; i < inputs.length; i += SYNC_BATCH_SIZE) {
    const batch = inputs.slice(i, i + SYNC_BATCH_SIZE);
    await chainOpsApi.syncBatch(walletId, batch);
  }
}

/**
 * UCB B5.4: возвращает `latestOpTime` из server-side cache в unix-seconds,
 * или `null` если wallet ни разу не синканся (или composite id невалиден).
 *
 * Используется в `load()` как дополнительный stop-criterion для DeBank
 * pagination когда client cache пуст. Скрывает все ошибки (network /
 * 401 / композитный id explore::) — вызывающий просто пропускает
 * delta-refresh и делает полный pull.
 */
async function fetchServerLatestOpTime(
  compositeId: string,
): Promise<number | null> {
  if (compositeId.startsWith("explore::")) return null;
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let walletId: string;
  if (compositeId.startsWith("api:")) {
    const parts = compositeId.split(":");
    if (parts.length < 2) return null;
    walletId = parts[1] ?? "";
  } else {
    walletId = compositeId;
  }
  if (!uuidRe.test(walletId)) return null;

  const s = await chainOpsApi.status(walletId);
  if (!s.latestOpTime) return null;
  const ms = Date.parse(s.latestOpTime);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

/**
 * UCB B5.3 Phase 2: server-side primary cache.
 *
 * Возвращает Loaded payload, восстановленный из `chain_operations` БД —
 * используется в bootstrap effect перед тем, как звонить DeBank/Helius.
 *
 * Когда применимо:
 *   - Fresh device: localStorage пуст, user logged in, server уже знает ops.
 *   - После явного `localStorage.clear()` (Reset App).
 *   - Multi-tab: первый tab пушит, остальные подхватывают без повторного pull.
 *
 * Возвращает `null` если:
 *   - composite id не парсится (`explore::…` или legacy non-`api:` entry).
 *   - Server вернул пустой массив (wallet ни разу не синхронился).
 *   - Запрос упал (network/server error) — caller fallthroughs к full load().
 *
 * `live` НЕ восстанавливаем — на старте у нас нет live balance из БД (это
 * UCB-агенда D8 / E1: state-cache). Поэтому UI до явного Refresh покажет
 * историю и cost basis, но live баланс будет пустым.
 */
async function tryHydrateFromServer(
  wallet: SavedWallet,
): Promise<Loaded | null> {
  if (wallet.id.startsWith("explore::")) return null;
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let walletId: string;
  if (wallet.id.startsWith("api:")) {
    const parts = wallet.id.split(":");
    if (parts.length < 2) return null;
    walletId = parts[1] ?? "";
  } else {
    walletId = wallet.id;
  }
  if (!uuidRe.test(walletId)) return null;

  const rows = await chainOpsApi.list(walletId);
  if (rows.length === 0) return null;

  // `raw` хранится как JSONB — у нас там лежит полный ClassifiedOp
  // (см. pushOpsToServer:raw: op). Восстанавливаем напрямую, без
  // ре-классификации (источник правды — то, что классификатор сохранил
  // во время первого pull). Если raw === null/missing (старые записи
  // до Phase 1), пропускаем.
  const ops: ClassifiedOp[] = [];
  for (const r of rows) {
    if (r.raw && typeof r.raw === "object") {
      ops.push(r.raw as ClassifiedOp);
    }
  }
  if (ops.length === 0) return null;

  // Newest first для consistency с DeBank-pull-order (это важно для
  // mergeOps / stop-on-known-hash логики).
  ops.sort((a, b) => b.time - a.time);

  const snapshot = buildSnapshot(wallet.id, wallet.address, ops);
  return {
    wallet,
    ops,
    snapshot,
    loadedAt: Date.now(),
    // Серверный chain_operations стор канонично полон (наполняется через
    // pushOpsToServer ПОСЛЕ полного бэкфилла). Поэтому гидратацию с сервера
    // считаем «история полна» → следующий DeBank-pull идёт дешёвым инкрементом,
    // а не повторным полным бэкфиллом на каждом свежем устройстве.
    historyComplete: true,
  };
}
