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
import { buildLotsAndPositions } from "@/lib/portfolio/positions";
import type { LotTracker } from "@/lib/portfolio/lots";
import type { PositionTracker } from "@/lib/portfolio/positions";
import { classifyHeliusHistory } from "@/lib/portfolio/solana_classifier";
import { buildSnapshot } from "@/lib/portfolio/reducer";
import type {
  ClassifiedOp,
  PortfolioSnapshot,
} from "@/lib/portfolio/types";
import { useIntegrations } from "@/lib/integrations";
import { useWallets, type SavedWallet, type WalletChain } from "@/lib/wallets";
import { useAuth } from "@/features/auth/AuthProvider";
import {
  deleteWalletCache,
  readAllWalletCacheIds,
  readWalletCache,
  writeWalletCache,
} from "@/lib/cache";
import { findInternalTransferPairs } from "@/lib/portfolio/internal_transfers";
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

export interface Loaded {
  wallet: SavedWallet;
  ops: ClassifiedOp[];
  snapshot: PortfolioSnapshot;
  loadedAt: number;
  /** Текущее on-chain состояние, чейн-нейтрально (EVM + Solana). */
  live?: LiveSnapshot;
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

  // Гидратация из localStorage при первом рендере: данные уже загруженных
  // кошельков восстанавливаются мгновенно, без API-запросов.
  const [loadedById, setLoadedById] = useState<Record<string, Loaded>>(() => {
    if (typeof window === "undefined") return {};
    const ids = readAllWalletCacheIds();
    const restored: Record<string, Loaded> = {};
    for (const id of ids) {
      const v = readWalletCache<Loaded>(id);
      if (v) restored[id] = v;
    }
    return restored;
  });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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
      const cached = options?.full ? null : loadedById[wallet.id];
      const knownHashes = cached ? new Set(cached.ops.map((o) => o.hash)) : null;

      try {
        let newOps: ClassifiedOp[];
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
          await fetchAllHistory(
            {
              address: wallet.address,
              accessKey: apiKey,
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
              ...(knownHashes && {
                stopWhen: (it: DeBankHistoryItem) => knownHashes.has(it.id),
              }),
            },
            ctrl.signal,
          );
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
        setLoadedById((prev) => ({ ...prev, [wallet.id]: payload }));
        // Персистентный кэш: при следующем заходе данные подтянутся без API.
        // Explore-кошельки (id `explore::…`) — НЕ кэшируем: это разовая
        // разведка чужого адреса, которая не должна попадать в дашборд при
        // следующем открытии.
        if (!wallet.id.startsWith("explore::")) {
          writeWalletCache(wallet.id, payload);
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

  // Авто-обновление кошельков раз в час. При первой загрузке (когда кэша нет)
  // данные подтянутся через `useEffect` ниже; затем тикаем каждый час.
  // Пользователь может в любой момент дёрнуть «Обновить» — отдельный path.
  const AUTO_REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 час
  const loadAllRef = useRef(loadAll);
  loadAllRef.current = loadAll;
  useEffect(() => {
    if (wallets.list.length === 0) return;
    const interval = window.setInterval(() => {
      // Не запускаем если уже идёт загрузка.
      if (abortRef.current) return;
      void loadAllRef.current();
    }, AUTO_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
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
  const lastUserIdRef = useRef<string | null>(null);
  useEffect(() => {
    const id = user?.id ?? null;
    if (lastUserIdRef.current === id) return;
    // Skip the very first transition (null → first user) — no stale
    // state to drop, and we want bootstrap to run on initial load.
    if (lastUserIdRef.current !== null) {
      for (const cid of readAllWalletCacheIds()) deleteWalletCache(cid);
      setLoadedById({});
      bootstrappedRef.current = false;
    }
    lastUserIdRef.current = id;
  }, [user?.id]);

  // Bootstrap: автоматически грузим только те кошельки, для которых нет кэша.
  // Если все уже в кэше — не делаем НИ ОДНОГО запроса.
  // Пользователь увидит данные мгновенно, обновляться будет только по
  // явной кнопке "Обновить".
  useEffect(() => {
    if (bootstrappedRef.current) return;
    if (wallets.list.length === 0) return;
    bootstrappedRef.current = true;
    // Грузим в фоне только новые кошельки (которых нет в кэше).
    const missing = wallets.list.filter((w) => !loadedById[w.id]);
    if (missing.length === 0) return;
    void (async () => {
      for (const w of missing) {
        if (!keyFor(w.chain)) continue;
        await load(w);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallets.list]);

  // Cross-wallet detection: пары internal-transfers между своими кошельками.
  // Пересчитывается мгновенно при любом изменении loadedById.
  const internalPairs = useMemo(() => {
    const items: { op: ClassifiedOp; walletId: string }[] = [];
    for (const id of Object.keys(loadedById)) {
      const l = loadedById[id]!;
      for (const op of l.ops) items.push({ op, walletId: l.wallet.id });
    }
    if (items.length === 0) return [];
    return findInternalTransferPairs(items).pairs;
  }, [loadedById]);

  const internalHashes = useMemo(() => {
    const set = new Set<string>();
    for (const p of internalPairs) {
      set.add(p.outHash);
      set.add(p.inHash);
    }
    return set;
  }, [internalPairs]);

  // Этап 12: параллельный run новых LotTracker/PositionTracker per wallet.
  // Пересчитывается при изменении loadedById. На existing UI не влияет.
  const newTrackers = useMemo(() => {
    const lotsByWallet = new Map<string, LotTracker>();
    const positionsByWallet = new Map<string, PositionTracker>();
    const walletNameById = new Map<string, string>();
    for (const id of Object.keys(loadedById)) {
      walletNameById.set(id, loadedById[id]!.wallet.name);
    }
    for (const id of Object.keys(loadedById)) {
      const l = loadedById[id]!;
      try {
        const { lots, positions } = buildLotsAndPositions(
          l.ops,
          l.wallet.id,
          { walletNameById },
        );
        lotsByWallet.set(l.wallet.id, lots);
        positionsByWallet.set(l.wallet.id, positions);
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
  }, [loadedById]);

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
