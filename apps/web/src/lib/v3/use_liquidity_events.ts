/**
 * React-хук: для каждой V3 NFT-позиции загружает все
 * IncreaseLiquidity / DecreaseLiquidity events через Alchemy и
 * вычисляет authoritative cost basis (Σ всех deposits − withdraws).
 *
 * **Решает Проблему #2 из аудита**: POS-001 XAUt показывает $56 startUsd
 * (из DeBank ops history) при live $162 (3× больше). Был дополнительный
 * `increaseLiquidity` который DeBank не вернул.
 *
 * Strategy:
 *   1. Для каждой live V3 NFT (из useV3Positions) — fetch all
 *      IncreaseLiquidity events
 *   2. Attach block timestamps
 *   3. Для каждого event'а: pricedUsd = amount0 × histPrice0 + amount1 × histPrice1
 *   4. Σ всех eventов = total cost basis
 *
 * Кэшируется в Map<tokenId, V3CostBasisResult> через React state.
 */

import { useEffect, useState, useMemo } from "react";

import { isStableSymbol } from "@/lib/portfolio/protocols";
import {
  defillamaCoinKey,
  fetchHistoricalPrices,
  priceFromMap,
} from "@/lib/defillama";
import {
  EtherscanChainNotSupportedError,
  fetchEtherscanLogs,
  parseLiquidityLog,
  uint256ToTopic,
} from "@/lib/etherscan_logs";
import {
  attachBlockTimes,
  fetchV3LiquidityEvents,
  type V3CostBasisResult,
  type V3LiquidityEvent,
} from "./liquidity_events";
import { fetchPoolMintPrice, type FetchPoolMintPriceArgs } from "./historical_pool_price";
import {
  estimateBlockAtTimestamp,
  getCurrentBlockNumber,
} from "./block_estimation";
import type { V3Position } from "./positions";
import type { V3Deployment } from "./chains";
import { findV3Deployments } from "./chains";

/** Event signatures (keccak256). */
const INCREASE_LIQ_TOPIC =
  "0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f";
const DECREASE_LIQ_TOPIC =
  "0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4";

/**
 * Module-level cache по `${chain}|${tokenId}` → V3CostBasisResult.
 * Persist в localStorage — events исторические, не меняются.
 *
 * ПРОБЛЕМА: React re-renders при наличии множественных hook instances
 * могут запускать effect 5+ раз, превышая Etherscan rate limit.
 * Module-cache + in-flight Set предотвращают это.
 */
// v2: переключение на pool slot0 цены (с DefiLlama hist на slot0 + USD anchor).
// v1 кэш не валиден потому что USD-значения отличаются на 0.1-0.5%.
// v2 → v3: добавлен DefiLlama historical-price fallback для exotic
// non-stable + non-anchor пар (WBTC/PAXG и т.п.). Старые v2 entries
// для таких пар содержали `netCostBasisUsd = 0` — нужно пересчитать.
// v3 → v4: persistCache теперь сохраняет Map withdrawalsByTxHash как
// Array<[hash, {amount0, amount1}]> (JSON.stringify на Map'е давал "{}",
// поле терялось). Без bump'а старые `v3` entries без `withdrawalsByTxHash`
// блокировали бы PR-2 split + PR-3 pre-mint filter навечно.
const CACHE_KEY = "capflow.cache.v3liq.v4";
const moduleCache = new Map<string, V3CostBasisResult>();

/**
 * In-flight Promise per `${chain}|${tokenId}` ключу.
 * React 18 StrictMode + re-renders могут запустить effect 2-3 раза подряд
 * — без guard'а каждый запустит параллельные fetch'и, превышая rate limit.
 * Все параллельные вызовы для одного tokenId await-ят одну Promise.
 */
const inFlight = new Map<string, Promise<V3CostBasisResult | null>>();

/**
 * Map<txHash, {amount0, amount1}> сериализуем как Array<[hash, value]> —
 * JSON.stringify на сыром Map'е даёт "{}" (Map не enumerable как Object),
 * поле полностью теряется при reload. Влияет на PR-2 (collect-vs-decrease
 * split) и PR-3 (pre-mint filter использует cb.mintBlockTime — НЕ Map,
 * но split всё равно read'ит withdrawalsByTxHash).
 */
type WithdrawalEntry = [string, { amount0: number; amount1: number }];

function rehydrate(item: Record<string, unknown>): V3CostBasisResult {
  const out: Record<string, unknown> = { ...item };
  out.tokenId = BigInt(item.tokenId as string);
  if (Array.isArray(item.withdrawalsByTxHash)) {
    out.withdrawalsByTxHash = new Map(item.withdrawalsByTxHash as WithdrawalEntry[]);
  } else {
    // Старый формат сериализации (JSON.stringify на Map давал {}) —
    // drop'аем пустое поле, чтобы downstream видел `undefined`, а не пустой Map.
    delete out.withdrawalsByTxHash;
  }
  return out as V3CostBasisResult;
}

// Загрузить cache из localStorage при старте.
try {
  const raw = localStorage.getItem(CACHE_KEY);
  if (raw) {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [k, v] of Object.entries(parsed)) {
      const item = v as Record<string, unknown>;
      if (item.tokenId && typeof item.tokenId === "string") {
        moduleCache.set(k, rehydrate(item));
      }
    }
  }
} catch {
  /* ignore */
}

function persistCache() {
  try {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of moduleCache) {
      const serialized: Record<string, unknown> = {
        ...v,
        tokenId: v.tokenId.toString(),
      };
      if (v.withdrawalsByTxHash) {
        serialized.withdrawalsByTxHash = Array.from(v.withdrawalsByTxHash.entries());
      }
      obj[k] = serialized;
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(obj));
  } catch {
    /* quota — ignore */
  }
}

interface State {
  /** tokenId.toString() → result */
  data: Map<string, V3CostBasisResult>;
  loading: boolean;
  error: string | null;
}

const EMPTY: Map<string, V3CostBasisResult> = new Map();

interface Target {
  tokenId: bigint;
  deployment: V3Deployment;
  position: V3Position;
}

/**
 * Когда Etherscan не покрывает chain (BASE etc.) и нужен Alchemy
 * fallback с chunked queries — выводим `fromBlock` из Krystal
 * `openedTime`. Без этого chunked-сканирование от earliest = millions
 * of requests → skip → empty result.
 *
 * Logic:
 *   1. Lookup Krystal openedTime для tokenId
 *   2. Если нет — return undefined (старое поведение)
 *   3. Получить current block (cached 1m)
 *   4. estimateBlockAtTimestamp(openedTime → block с safety margin)
 */
async function deriveFromBlockFromKrystal(
  t: Target,
  krystalOpenedTimeByTokenId: KrystalOpenedTimeLookup | undefined,
  alchemyKey: string,
): Promise<bigint | null> {
  if (!krystalOpenedTimeByTokenId) return null;
  const openedTime = krystalOpenedTimeByTokenId.get(t.tokenId.toString());
  if (!openedTime || openedTime <= 0) return null;
  const currentBlock = await getCurrentBlockNumber(t.deployment, alchemyKey);
  if (currentBlock == null) return null;
  const estimated = estimateBlockAtTimestamp({
    chainCode: t.position.chain,
    currentBlock,
    targetTimestampSec: openedTime,
  });
  if (estimated != null && typeof window !== "undefined") {
    console.log(
      `[useV3LiquidityEvents] fromBlock=${estimated} for NFT ${t.tokenId} (chain ${t.position.chain}, opened ${new Date(openedTime * 1000).toISOString().slice(0, 10)})`,
    );
  }
  return estimated;
}

/**
 * Optional Krystal data lookup для fromBlock estimation на chain'ах
 * где Etherscan free tier не работает (BASE). Key = tokenId, value =
 * Krystal `openedTime` (Unix sec). Передаётся из useComputedPositions
 * после useKrystalV3Positions hook.
 */
export type KrystalOpenedTimeLookup = ReadonlyMap<string, number | null>;

export function useV3LiquidityEvents(
  v3Positions: V3Position[],
  alchemyKey: string,
  etherscanKey?: string,
  krystalOpenedTimeByTokenId?: KrystalOpenedTimeLookup,
): State {
  const [data, setData] = useState<Map<string, V3CostBasisResult>>(EMPTY);
  // Bug E (2026-05-25 O_lll_ABC_lll_O audit): инициальный loading=true
  // чтобы первый render показывал spinner вместо ⚠ badge на V3 LP позициях
  // с coverageIncomplete. Раньше:
  //   t0: loading=false → render → coverageIncomplete=true && loading=false → ⚠
  //   t0+ε: useEffect → setLoading(true) async
  //   t10s: fetch done → override → coverageIncomplete=false → ⚠ убирается
  // Теперь:
  //   t0: loading=true → render → spinner
  //   t10s: setLoading(false) + override → spinner→nothing
  // Early-return branch (no key / no targets) явно ставит loading=false.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Найти deployment для каждой позиции (через protocolLabel + chain).
  const targets = useMemo<Target[]>(() => {
    const out: Target[] = [];
    for (const pos of v3Positions) {
      const deps = findV3Deployments(pos.chain, pos.protocolLabel);
      const dep = deps[0];
      if (!dep) continue;
      out.push({ tokenId: pos.tokenId, deployment: dep, position: pos });
    }
    return out;
  }, [v3Positions]);

  useEffect(() => {
    console.log("[useV3LiquidityEvents] effect run", {
      alchemyKey: alchemyKey ? alchemyKey.slice(0, 8) + "..." : "NONE",
      targetsCount: targets.length,
      targets: targets.map((t) => ({
        tokenId: t.tokenId.toString(),
        chain: t.position.chain,
        deployment: t.deployment.id,
      })),
    });
    if (!alchemyKey || targets.length === 0) {
      console.log("[useV3LiquidityEvents] skipped: no key or no targets");
      setData(EMPTY);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      const result = new Map<string, V3CostBasisResult>();
      const errors: string[] = [];

      // Сначала собираем все события + attach block times.
      type Acc = {
        target: Target;
        increases: V3LiquidityEvent[];
        decreases: V3LiquidityEvent[];
      };
      const accs: Acc[] = [];

      // Источник #1: Etherscan v2 (если есть key) — без block-range limit.
      // Источник #2: Alchemy — может упасть на free tier.
      const useEtherscan = etherscanKey && etherscanKey.length > 0;

      // Throttling: Etherscan free tier = 5 req/sec. Sequential pipeline
      // с задержкой 250мс между запросами (≤ 4 req/sec).
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      // Pre-populate from module cache (skip already-fetched tokenIds).
      // Это критично — React re-renders могут вызывать hook несколько раз,
      // без cache мы быстро превышаем rate limit.
      const targetsToFetch: Target[] = [];
      // Также awaitим in-flight Promise'ы (другой instance hook'а уже
      // фетчит этот tokenId — переиспользуем результат).
      const awaitInFlight: { target: Target; promise: Promise<V3CostBasisResult | null> }[] = [];
      for (const t of targets) {
        const cacheKey = `${t.position.chain}|${t.tokenId.toString()}`;
        const cached = moduleCache.get(cacheKey);
        if (cached) {
          result.set(t.tokenId.toString(), cached);
          continue;
        }
        const pending = inFlight.get(cacheKey);
        if (pending) {
          awaitInFlight.push({ target: t, promise: pending });
          continue;
        }
        targetsToFetch.push(t);
      }
      // Дождаться in-flight fetches других hook instances и забрать их результат.
      for (const { target, promise } of awaitInFlight) {
        try {
          const r = await promise;
          if (r) result.set(target.tokenId.toString(), r);
        } catch (e) {
          errors.push(`${target.tokenId}: ${(e as Error).message} (in-flight)`);
        }
      }
      if (targetsToFetch.length === 0) {
        // Все из cache / in-flight — skip fetch entirely.
        if (cancelled) return;
        setData(result);
        setLoading(false);
        return;
      }
      // Регистрируем in-flight Promise per target ДО старта fetch'а,
      // чтобы параллельные hook instances могли await'ить вместо дублирования.
      const inFlightResolvers = new Map<string, (r: V3CostBasisResult | null) => void>();
      for (const t of targetsToFetch) {
        const cacheKey = `${t.position.chain}|${t.tokenId.toString()}`;
        const p = new Promise<V3CostBasisResult | null>((resolve) => {
          inFlightResolvers.set(cacheKey, resolve);
        });
        inFlight.set(cacheKey, p);
      }
      // Сети, для которых Etherscan free tier вернул "chain not supported"
      // — кэшируем чтобы не повторять запрос для каждого NFT той же сети.
      const etherscanUnsupportedChains = new Set<string>();

      for (const t of targetsToFetch) {
        try {
          let increases: V3LiquidityEvent[] = [];
          let decreases: V3LiquidityEvent[] = [];
          const chainSupportsEtherscan =
            useEtherscan && !etherscanUnsupportedChains.has(t.position.chain);
          if (chainSupportsEtherscan) {
            try {
              const tokenIdTopic = uint256ToTopic(t.tokenId);
              const incRaw = await fetchEtherscanLogs(
                t.position.chain,
                t.deployment.npm,
                INCREASE_LIQ_TOPIC,
                tokenIdTopic,
                etherscanKey!,
              );
              await sleep(250);
              const decRaw = await fetchEtherscanLogs(
                t.position.chain,
                t.deployment.npm,
                DECREASE_LIQ_TOPIC,
                tokenIdTopic,
                etherscanKey!,
              );
              await sleep(250);
              increases = incRaw.map((log) => {
                const p = parseLiquidityLog(log);
                return {
                  type: "increase" as const,
                  tokenId: p.tokenId,
                  blockNumber: p.blockNumber,
                  blockTime: p.blockTime,
                  txHash: p.txHash,
                  liquidity: p.liquidity,
                  amount0Raw: p.amount0,
                  amount1Raw: p.amount1,
                };
              });
              decreases = decRaw.map((log) => {
                const p = parseLiquidityLog(log);
                return {
                  type: "decrease" as const,
                  tokenId: p.tokenId,
                  blockNumber: p.blockNumber,
                  blockTime: p.blockTime,
                  txHash: p.txHash,
                  liquidity: p.liquidity,
                  amount0Raw: p.amount0,
                  amount1Raw: p.amount1,
                };
              });
            } catch (etherscanErr) {
              if (etherscanErr instanceof EtherscanChainNotSupportedError) {
                // Etherscan free tier не поддерживает эту сеть (например BASE).
                // Помечаем для всех последующих NFT этой сети + fallback'имся
                // на Alchemy для текущего NFT.
                etherscanUnsupportedChains.add(t.position.chain);
                console.warn(
                  `[useV3LiquidityEvents] Etherscan unsupported for chain=${t.position.chain}, falling back to Alchemy`,
                );
                const fromBlock = await deriveFromBlockFromKrystal(
                  t,
                  krystalOpenedTimeByTokenId,
                  alchemyKey,
                );
                const events = await fetchV3LiquidityEvents(
                  t.deployment,
                  t.tokenId,
                  alchemyKey,
                  fromBlock != null ? { fromBlock } : undefined,
                );
                const [inc, dec] = await Promise.all([
                  attachBlockTimes(t.deployment, alchemyKey, events.increases),
                  attachBlockTimes(t.deployment, alchemyKey, events.decreases),
                ]);
                increases = inc;
                decreases = dec;
              } else {
                throw etherscanErr;
              }
            }
          } else {
            // Etherscan не используется ИЛИ сеть не поддерживается — Alchemy.
            const fromBlock = await deriveFromBlockFromKrystal(
              t,
              krystalOpenedTimeByTokenId,
              alchemyKey,
            );
            const events = await fetchV3LiquidityEvents(
              t.deployment,
              t.tokenId,
              alchemyKey,
              fromBlock != null ? { fromBlock } : undefined,
            );
            const [inc, dec] = await Promise.all([
              attachBlockTimes(t.deployment, alchemyKey, events.increases),
              attachBlockTimes(t.deployment, alchemyKey, events.decreases),
            ]);
            increases = inc;
            decreases = dec;
          }
          accs.push({ target: t, increases, decreases });
        } catch (e) {
          errors.push(`${t.tokenId}: ${(e as Error).message}`);
        }
      }

      // ───────────────────────────────────────────────────────────────
      // Pool slot0 методика для USD-цен в момент event'а.
      //
      // Для каждого event'а читаем `pool.slot0()` на (blockNumber - 1)
      // через Alchemy archive — даёт ТОЧНЫЙ sqrtPriceX96 что использовал
      // контракт при mint'е. Для volatile/volatile pool'ов (нет стейбла на
      // ни одной стороне) `fetchPoolMintPrice` дополнительно читает slot0
      // anchor pool'а (WETH/USDC, WMATIC/USDC и т.д.) на том же блоке.
      //
      // Это устраняет ~0.2-0.5% drift от DefiLlama hourly buckets.
      // ───────────────────────────────────────────────────────────────
      type PoolPriceCacheValue = {
        price1Per0: number;
        decimals0: number;
        decimals1: number;
        anchorTokenAddress?: string;
        anchorTokenUsd?: number;
      };
      const poolPriceCache = new Map<string, PoolPriceCacheValue>();
      // Уникальные tx hashes (chain | poolAddress | txHash).
      const poolPriceRequests = new Map<string, FetchPoolMintPriceArgs>();
      for (const acc of accs) {
        for (const e of [...acc.increases, ...acc.decreases]) {
          const k = `${acc.target.position.chain}|${acc.target.position.poolAddress.toLowerCase()}|${e.txHash.toLowerCase()}`;
          if (poolPriceRequests.has(k)) continue;
          poolPriceRequests.set(k, {
            chainCode: acc.target.position.chain,
            poolAddress: acc.target.position.poolAddress,
            txHash: e.txHash,
            alchemyApiKey: alchemyKey,
          });
        }
      }
      // Throttling: Alchemy free tier позволяет ~25 req/sec на endpoint,
      // sequential pipeline без задержки уже OK. Но fetchPoolMintPrice
      // делает 4 RPC calls (receipt, token0, token1, decimals × 2 +
      // slot0 + anchor slot0). Ставим лёгкий throttle 50ms.
      for (const [k, req] of poolPriceRequests) {
        try {
          const res = await fetchPoolMintPrice(req);
          if (res) {
            poolPriceCache.set(k, {
              price1Per0: res.price1Per0,
              decimals0: res.decimals0,
              decimals1: res.decimals1,
              ...(res.anchorTokenAddress && { anchorTokenAddress: res.anchorTokenAddress }),
              ...(res.anchorTokenUsd != null && { anchorTokenUsd: res.anchorTokenUsd }),
            });
          }
        } catch (err) {
          errors.push(`slot0 ${req.txHash.slice(0, 10)}: ${(err as Error).message}`);
        }
        await sleep(50);
      }

      // ─── Phase B: DefiLlama historical-price fallback ─────────────
      // Pools where neither token is a stable AND neither token is the
      // anchor (typically WETH) — e.g. WBTC/PAXG, ETH/WBTC on a sidechain
      // where the anchor pool isn't WETH/USDC — could not be priced by
      // slot0 alone.  We hit DefiLlama for the underlying token USD
      // prices at each event's blockTime.  One batched call across all
      // such events.
      const defillamaNeeds: { coin: string; timestamp: number }[] = [];
      const seenLookups = new Set<string>();
      for (const acc of accs) {
        const t0Sym = acc.target.position.token0.symbol;
        const t1Sym = acc.target.position.token1.symbol;
        if (isStableSymbol(t0Sym) || isStableSymbol(t1Sym)) continue;
        const chain = acc.target.position.chain;
        const t0Coin = defillamaCoinKey(chain, acc.target.position.token0.address, t0Sym);
        const t1Coin = defillamaCoinKey(chain, acc.target.position.token1.address, t1Sym);
        if (!t0Coin || !t1Coin) continue;
        for (const e of [...acc.increases, ...acc.decreases]) {
          if (!e.blockTime) continue;
          const k0 = `${t0Coin}|${e.blockTime}`;
          if (!seenLookups.has(k0)) {
            seenLookups.add(k0);
            defillamaNeeds.push({ coin: t0Coin, timestamp: e.blockTime });
          }
          const k1 = `${t1Coin}|${e.blockTime}`;
          if (!seenLookups.has(k1)) {
            seenLookups.add(k1);
            defillamaNeeds.push({ coin: t1Coin, timestamp: e.blockTime });
          }
        }
      }
      let llamaPrices: Map<string, number> | null = null;
      if (defillamaNeeds.length > 0) {
        try {
          llamaPrices = await fetchHistoricalPrices(defillamaNeeds);
        } catch (err) {
          errors.push(`defillama-fallback: ${(err as Error).message}`);
        }
      }

      // Конвертация (slot0 ratio) → (USD price0, USD price1).
      // Логика:
      //   1. Если token1 — стейбл → price0 = price1Per0, price1 = $1
      //      (1 token0 даёт price1Per0 USDC, → 1 token0 = $price1Per0)
      //   2. Если token0 — стейбл → price0 = $1, price1 = 1 / price1Per0
      //   3. Иначе используем USD-anchor (WETH/USDC slot0 на том же блоке):
      //      a. token0 == anchor → price0 = anchorTokenUsd,
      //         price1 = anchorTokenUsd / price1Per0
      //      b. token1 == anchor → price1 = anchorTokenUsd,
      //         price0 = anchorTokenUsd × price1Per0
      //   4. DefiLlama historical-price fallback per token + event.blockTime
      //      (WBTC/PAXG and similar exotic pairs where neither side is
      //      anchor on the local chain).
      //   5. Если всё mimo — null (skipping cost basis для этого event'а).
      function deriveUsdPrices(
        target: Target,
        pp: PoolPriceCacheValue,
        event?: V3LiquidityEvent,
      ): { p0: number; p1: number } | null {
        const t0Sym = target.position.token0.symbol;
        const t1Sym = target.position.token1.symbol;
        const t0Addr = target.position.token0.address.toLowerCase();
        const t1Addr = target.position.token1.address.toLowerCase();
        const stable0 = isStableSymbol(t0Sym);
        const stable1 = isStableSymbol(t1Sym);
        if (stable1) {
          return { p0: pp.price1Per0, p1: 1 };
        }
        if (stable0) {
          if (pp.price1Per0 <= 0) return null;
          return { p0: 1, p1: 1 / pp.price1Per0 };
        }
        const anchorAddr = pp.anchorTokenAddress?.toLowerCase();
        const anchorUsd = pp.anchorTokenUsd;
        if (anchorAddr && anchorUsd && anchorUsd > 0) {
          if (t0Addr === anchorAddr) {
            if (pp.price1Per0 <= 0) return null;
            return { p0: anchorUsd, p1: anchorUsd / pp.price1Per0 };
          }
          if (t1Addr === anchorAddr) {
            return { p0: anchorUsd * pp.price1Per0, p1: anchorUsd };
          }
        }
        // DefiLlama fallback — direct per-token historical USD prices.
        if (event?.blockTime && llamaPrices) {
          const chain = target.position.chain;
          const t0Coin = defillamaCoinKey(chain, t0Addr, t0Sym);
          const t1Coin = defillamaCoinKey(chain, t1Addr, t1Sym);
          if (t0Coin && t1Coin) {
            const p0 = priceFromMap(llamaPrices, t0Coin, event.blockTime);
            const p1 = priceFromMap(llamaPrices, t1Coin, event.blockTime);
            if (p0 != null && p0 > 0 && p1 != null && p1 > 0) {
              return { p0, p1 };
            }
          }
        }
        return null;
      }

      // DEBUG: per-event breakdown — exposed via window.__v3PerEventAudit
      // для аудита (token amounts, USD prices, event tx hash, blockTime).
      type EventAudit = {
        tokenId: string;
        type: "increase" | "decrease";
        txHash: string;
        blockNumber: string;
        blockTime: number | null;
        token0: { symbol: string; amount: number; usdPrice: number | null };
        token1: { symbol: string; amount: number; usdPrice: number | null };
        eventUsd: number | null;
      };
      const auditEvents: EventAudit[] = [];

      // Считаем cost basis per NFT.
      for (const acc of accs) {
        const { target } = acc;
        const dec0 = target.position.token0.decimals;
        const dec1 = target.position.token1.decimals;

        let totalDeposited0 = 0;
        let totalDeposited1 = 0;
        let totalWithdrawn0 = 0;
        let totalWithdrawn1 = 0;
        let totalDepositUsd = 0;
        let totalWithdrawUsd = 0;
        let hasHistPrices = false;
        // PR-2: per-tx withdrawal amounts for collect-vs-decrease split.
        const withdrawalsByTxHash = new Map<string, { amount0: number; amount1: number }>();

        function pricesForEvent(e: V3LiquidityEvent): { p0: number; p1: number } | null {
          const k = `${target.position.chain}|${target.position.poolAddress.toLowerCase()}|${e.txHash.toLowerCase()}`;
          const pp = poolPriceCache.get(k);
          if (!pp) return null;
          return deriveUsdPrices(target, pp, e);
        }

        for (const e of acc.increases) {
          const a0 = Number(e.amount0Raw) / 10 ** dec0;
          const a1 = Number(e.amount1Raw) / 10 ** dec1;
          totalDeposited0 += a0;
          totalDeposited1 += a1;
          const px = pricesForEvent(e);
          if (px) {
            hasHistPrices = true;
            totalDepositUsd += a0 * px.p0 + a1 * px.p1;
          }
          auditEvents.push({
            tokenId: target.tokenId.toString(),
            type: "increase",
            txHash: e.txHash,
            blockNumber: e.blockNumber.toString(),
            blockTime: e.blockTime ?? null,
            token0: {
              symbol: target.position.token0.symbol,
              amount: a0,
              usdPrice: px?.p0 ?? null,
            },
            token1: {
              symbol: target.position.token1.symbol,
              amount: a1,
              usdPrice: px?.p1 ?? null,
            },
            eventUsd: px ? a0 * px.p0 + a1 * px.p1 : null,
          });
        }
        for (const e of acc.decreases) {
          const a0 = Number(e.amount0Raw) / 10 ** dec0;
          const a1 = Number(e.amount1Raw) / 10 ** dec1;
          totalWithdrawn0 += a0;
          totalWithdrawn1 += a1;
          // PR-2: per-tx aggregation (несколько decrease events в одном
          // multicall tx складываем). Lowercase txHash для consistent match
          // против op.hash (DeBank часто mixed-case).
          const key = e.txHash.toLowerCase();
          const prev = withdrawalsByTxHash.get(key);
          if (prev) {
            withdrawalsByTxHash.set(key, {
              amount0: prev.amount0 + a0,
              amount1: prev.amount1 + a1,
            });
          } else {
            withdrawalsByTxHash.set(key, { amount0: a0, amount1: a1 });
          }
          const px = pricesForEvent(e);
          if (px) {
            totalWithdrawUsd += a0 * px.p0 + a1 * px.p1;
          }
          auditEvents.push({
            tokenId: target.tokenId.toString(),
            type: "decrease",
            txHash: e.txHash,
            blockNumber: e.blockNumber.toString(),
            blockTime: e.blockTime ?? null,
            token0: {
              symbol: target.position.token0.symbol,
              amount: a0,
              usdPrice: px?.p0 ?? null,
            },
            token1: {
              symbol: target.position.token1.symbol,
              amount: a1,
              usdPrice: px?.p1 ?? null,
            },
            eventUsd: px ? a0 * px.p0 + a1 * px.p1 : null,
          });
        }

        // Net cost basis: для V3 LP важен оригинальный capital invested
        // минус то что юзер уже вывел (партиальные closes). Если withdraw'ов
        // нет, netCostBasis == totalDepositUsd.
        const netCostBasisUsd = Math.max(
          0,
          totalDepositUsd - totalWithdrawUsd,
        );

        // Earliest IncreaseLiquidity = mint tx (для match'а с OpenPosition.openHash).
        const sortedInc = [...acc.increases].sort((a, b) =>
          Number(a.blockNumber - b.blockNumber),
        );
        const mintTxHash = sortedInc[0]?.txHash;
        const mintBlockTime = sortedInc[0]?.blockTime;
        const item: V3CostBasisResult = {
          tokenId: target.tokenId,
          totalDeposited0,
          totalDeposited1,
          totalWithdrawn0,
          totalWithdrawn1,
          totalDepositUsd,
          totalWithdrawUsd,
          netCostBasisUsd,
          eventCount: {
            increase: acc.increases.length,
            decrease: acc.decreases.length,
          },
          hasHistPrices,
          ...(mintTxHash && { mintTxHash }),
          ...(mintBlockTime !== undefined && { mintBlockTime }),
          ...(withdrawalsByTxHash.size > 0 && { withdrawalsByTxHash }),
        };
        const cacheKey = `${target.position.chain}|${target.tokenId.toString()}`;
        // НЕ кэшируем "empty" результаты (0 increase events) — это значит
        // что мы не смогли получить данные с цепочки (Alchemy free tier
        // chunked без fromBlock skip'ает; Etherscan не покрыл chain).
        // DeBank-derived startUsd должен остаться primary в таких случаях.
        // Если пользователь обновит API plan — hook попробует заново.
        if (acc.increases.length > 0 || acc.decreases.length > 0) {
          result.set(target.tokenId.toString(), item);
          moduleCache.set(cacheKey, item);
        }
        // Резолвим in-flight Promise (даже если empty — чтобы waiters не висели).
        inFlightResolvers.get(cacheKey)?.(
          (acc.increases.length > 0 || acc.decreases.length > 0) ? item : null,
        );
        inFlight.delete(cacheKey);
      }
      // Зарезолвить любые оставшиеся (для targets, у которых fetch упал
      // и мы их не дошли до compute loop'а).
      for (const t of targetsToFetch) {
        const cacheKey = `${t.position.chain}|${t.tokenId.toString()}`;
        if (inFlight.has(cacheKey)) {
          inFlightResolvers.get(cacheKey)?.(null);
          inFlight.delete(cacheKey);
        }
      }
      persistCache();

      if (cancelled) return;
      // Save to window for inspection
      (window as unknown as { __v3PerEventAudit?: unknown }).__v3PerEventAudit = auditEvents;
      (window as unknown as { __v3CostBasisDebug: unknown }).__v3CostBasisDebug = {
        resultSize: result.size,
        entries: [...result.entries()].map(([k, v]) => ({
          tokenId: k,
          netCostBasisUsd: v.netCostBasisUsd,
          totalDeposited0: v.totalDeposited0,
          totalDeposited1: v.totalDeposited1,
          eventCount: v.eventCount,
          hasHistPrices: v.hasHistPrices,
        })),
        errors,
        timestamp: new Date().toISOString(),
      };
      console.log("[useV3LiquidityEvents] complete: " + JSON.stringify({
        resultSize: result.size,
        sample: [...result.entries()].slice(0, 3).map(([k, v]) => ({
          tokenId: k,
          netCostBasisUsd: v.netCostBasisUsd,
          eventCount: v.eventCount,
        })),
        errors,
      }));
      setData(result);
      setLoading(false);
      if (errors.length > 0) setError(errors.slice(0, 3).join("; "));
    })();

    return () => {
      cancelled = true;
    };
    // krystalOpenedTimeByTokenId как dep: когда Krystal данные приходят
    // позже useV3LiquidityEvents first run (типичная race), effect
    // re-run с newly available openedTime → fromBlock → success on BASE.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alchemyKey, targets, krystalOpenedTimeByTokenId]);

  return { data, loading, error };
}
