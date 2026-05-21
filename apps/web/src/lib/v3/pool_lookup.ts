/**
 * V3 pool address resolver from a tx hash.
 *
 * **Зачем**: для точного матчинга live V3 LP позиций (от DeBank) к
 * `lp_add` ops в нашем chain-ops registry. DeBank даёт `lp.lpTokenId`
 * = адрес пула. Наши ops хранят только tx_hash. Без знания pool address
 * для каждого mint'а матчер использует heuristic «pair+amounts», что
 * фейлится когда у юзера несколько NFT в разных fee tiers того же pair
 * (POS-007/008 PAXG/USDC bug).
 *
 * **Как**: фетчим tx receipt → ищем `Mint` event V3-пула (topic0
 * сигнатура `Mint(sender,owner,tickLower,tickUpper,amount,a0,a1)`) →
 * возвращаем `log.address` — это адрес контракт-пула, эмитировавшего
 * событие. Каждый V3 пул эмитит свой `Mint` на любую liquidity
 * addition, поэтому это работает и для initial mint, и для
 * IncreaseLiquidity.
 *
 * **Cache**: in-memory Map + localStorage persistence. tx → pool
 * address неизменно навсегда, безопасно кэшировать перманентно.
 *
 * **Cost**: 1 `eth_getTransactionReceipt` RPC call per uncached tx.
 * Alchemy free tier: 300 CU/sec; receipt = 15 CU → 20 ops/sec безопасно.
 * Параллелим до 5 одновременно чтобы не задавить.
 */

import {
  createPublicClient,
  http,
  type Hex,
  type PublicClient,
} from "viem";

import { alchemyRpcUrl, V3_DEPLOYMENTS, type V3Deployment } from "./chains";

/**
 * Topic0 = keccak256("Mint(address,address,int24,int24,uint128,uint256,uint256)").
 * Uniswap V3 Pool emits this on every liquidity addition.
 * PancakeSwap V3 и форки используют ту же signature → resolver работает
 * для всех V3-style протоколов.
 */
const V3_POOL_MINT_TOPIC0 =
  "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde";

const CACHE_KEY = "capflow.v3_pool_lookup.v1";

interface CacheEntry {
  /** Lowercase pool address or empty string if no Mint event was found. */
  pool: string;
  ts: number;
}

let memCache: Map<string, CacheEntry> | null = null;

function getCache(): Map<string, CacheEntry> {
  if (memCache) return memCache;
  memCache = new Map();
  if (typeof localStorage === "undefined") return memCache;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return memCache;
    const obj = JSON.parse(raw) as Record<string, CacheEntry>;
    for (const [k, v] of Object.entries(obj)) {
      memCache.set(k, v);
    }
  } catch {
    /* corrupted cache — start fresh */
  }
  return memCache;
}

function persistCache(): void {
  if (!memCache || typeof localStorage === "undefined") return;
  try {
    const obj: Record<string, CacheEntry> = {};
    for (const [k, v] of memCache.entries()) obj[k] = v;
    localStorage.setItem(CACHE_KEY, JSON.stringify(obj));
  } catch {
    /* quota exceeded — silently drop */
  }
}

const clientCache = new Map<string, PublicClient>();

function clientFor(dep: V3Deployment, apiKey: string): PublicClient {
  const key = `${dep.id}|${apiKey.slice(0, 8)}`;
  let c = clientCache.get(key);
  if (c) return c;
  c = createPublicClient({
    chain: dep.chain,
    transport: http(alchemyRpcUrl(dep, apiKey), {
      batch: true,
      // S3.5: cookie-based auth для backend upstream-proxy.
      fetchOptions: { credentials: "include" },
    }),
  });
  clientCache.set(key, c);
  return c;
}

/**
 * Resolve pool address from a single tx hash.
 *
 * Returns `null` если в tx нет `Mint` event V3-пула (например, это
 * не V3 lp_add вообще, или произошёл revert). Returns lowercase hex
 * address при успехе.
 *
 * **Cache**: результат запоминается перманентно (tx-immutable).
 */
export async function getV3PoolFromTx(
  chain: string,
  txHash: string,
  alchemyKey: string,
): Promise<string | null> {
  const cache = getCache();
  const key = `${chain.toLowerCase()}|${txHash.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit) return hit.pool || null;

  const dep = V3_DEPLOYMENTS.find((d) => d.chainCode === chain);
  if (!dep) return null;

  const client = clientFor(dep, alchemyKey);
  let pool = "";
  try {
    const receipt = await client.getTransactionReceipt({
      hash: txHash as Hex,
    });
    // Берём ПЕРВЫЙ log с Mint event signature. Если в одном tx несколько
    // mint'ов (multicall mintMany), у нас будет N разных pool addresses
    // — нужно вернуть ВСЕ, но текущий API одно-tx → одна позиция; этот
    // edge case покрыть отдельным API (getAllPoolsFromTx) если нужно.
    for (const log of receipt.logs) {
      if (log.topics[0]?.toLowerCase() === V3_POOL_MINT_TOPIC0) {
        pool = log.address.toLowerCase();
        break;
      }
    }
  } catch (e) {
    // Сетевая ошибка / 403 / etc. — НЕ кэшируем (чтобы перезапросить
    // в следующий раз). null будет возвращён.
    if (typeof window !== "undefined") {
      console.warn(
        `[v3-pool-lookup] failed for ${chain}|${txHash.slice(0, 10)}: ${(e as Error).message}`,
      );
    }
    return null;
  }

  cache.set(key, { pool, ts: Date.now() });
  // Persist лениво (batch persist через 500ms debounce было бы лучше,
  // но JSON.stringify до 5к записей < 5ms — пока хватает sync save).
  persistCache();
  return pool || null;
}

/**
 * Batch resolve для списка (chain, txHash) пар. Конкурентность 5
 * чтобы не задавить Alchemy.
 *
 * Возвращает Map<`${chain}|${txHash.toLowerCase()}`, pool|null>.
 * Кешированные значения возвращаются без запроса.
 */
export async function getV3PoolsForMintBatch(
  items: ReadonlyArray<{ chain: string; txHash: string }>,
  alchemyKey: string,
  concurrency = 5,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (!alchemyKey) {
    // Нет ключа — silently skip; caller fallback'нётся на heuristic.
    return out;
  }
  // Уникальные пары — несколько ops с одним hash (редко, но возможно).
  const seen = new Set<string>();
  const queue: { chain: string; txHash: string; key: string }[] = [];
  for (const it of items) {
    const key = `${it.chain.toLowerCase()}|${it.txHash.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push({ chain: it.chain, txHash: it.txHash, key });
  }

  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < queue.length) {
      const i = idx++;
      const job = queue[i]!;
      const pool = await getV3PoolFromTx(job.chain, job.txHash, alchemyKey);
      out.set(job.key, pool);
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, queue.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return out;
}
