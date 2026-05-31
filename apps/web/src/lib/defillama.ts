/**
 * Клиент DefiLlama Coins API — исторические USD-цены токенов.
 *
 *   GET /prices/historical/{timestamp}/{coin1},{coin2},...?searchWidth=4h
 *
 *   coin = "{chain}:{contractAddress}" или "coingecko:{id}"
 *   chain ∈ {ethereum, arbitrum, optimism, base, polygon, bsc, avax, fantom,
 *           solana, ...}
 *
 * Кэш: localStorage `capflow.cache.defillama.v1` — ключи вида
 * `{coin}|{tsHour}` (час округления). Исторические цены не меняются →
 * кэшируем перманентно.
 *
 * A0: pure helpers (defillamaCoinKey / priceFromMap / priceFromMapNearest +
 * the `cacheKeyFor`/`bucketTs` key format) moved to `@cap-flow/ucb/pricing`.
 * They are imported here (the fetch client uses the SAME key format) and
 * re-exported so existing `@/lib/defillama` import sites keep working.
 */
import {
  bucketTs,
  cacheKeyFor,
  defillamaCoinKey,
  priceFromMap,
  priceFromMapNearest,
} from "@cap-flow/ucb/pricing";

export { defillamaCoinKey, priceFromMap, priceFromMapNearest };

const PROXY = "/defillama";
const CACHE_KEY = "capflow.cache.defillama.v1";
const SEARCH_WIDTH = "4h";

/* ----------------------------- cache ------------------------------------- */

interface CacheShape {
  [key: string]: number; // price
}

function readCache(): CacheShape {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as CacheShape) : {};
  } catch {
    return {};
  }
}

function writeCache(c: CacheShape): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    /* quota — игнорируем */
  }
}

/* ----------------------------- fetch ------------------------------------- */

interface LlamaResponseItem {
  symbol?: string;
  price?: number;
  decimals?: number;
  timestamp?: number;
  confidence?: number;
}
interface LlamaResponse {
  coins?: Record<string, LlamaResponseItem>;
}

async function fetchOneTs(
  ts: number,
  coins: string[],
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (coins.length === 0) return out;
  // URL длиной не больше ~7000 символов; режем на чанки по 50 coin'ов.
  const CHUNK = 50;
  for (let i = 0; i < coins.length; i += CHUNK) {
    const chunk = coins.slice(i, i + CHUNK);
    const url = `${PROXY}/prices/historical/${ts}/${chunk.join(",")}?searchWidth=${SEARCH_WIDTH}`;
    try {
      const init: RequestInit = {
        method: "GET",
        headers: { Accept: "application/json" },
      };
      if (signal) init.signal = signal;
      const res = await fetch(url, init);
      if (!res.ok) continue;
      const json = (await res.json()) as LlamaResponse;
      for (const [coin, v] of Object.entries(json.coins ?? {})) {
        if (typeof v.price === "number" && v.price > 0)
          out.set(coin, v.price);
      }
    } catch {
      /* one chunk failed — keep going */
    }
  }
  return out;
}

/**
 * Достать исторические цены для произвольного списка (coin, timestamp).
 * Группируем по округлённому часовому ts, чтобы не делать лишних запросов.
 * Кэш сохраняется в localStorage.
 */
export async function fetchHistoricalPrices(
  items: { coin: string; timestamp: number }[],
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const result = new Map<string, number>(); // ключ: cacheKeyFor(coin, ts)
  const cache = readCache();

  // 1. По кэшу.
  const need: { coin: string; tsBucket: number }[] = [];
  for (const it of items) {
    const k = cacheKeyFor(it.coin, it.timestamp);
    if (cache[k] != null) {
      result.set(k, cache[k]);
    } else {
      need.push({ coin: it.coin, tsBucket: bucketTs(it.timestamp) });
    }
  }

  if (need.length === 0) return result;

  // 2. Группируем по ts-bucket.
  const byTs = new Map<number, Set<string>>();
  for (const { coin, tsBucket } of need) {
    let s = byTs.get(tsBucket);
    if (!s) {
      s = new Set();
      byTs.set(tsBucket, s);
    }
    s.add(coin);
  }

  // 3. Делаем запросы по ts-bucket с ограниченной параллельностью.
  //
  // 2026-05-29 (MMaksimuk POS-024): раньше шли строго последовательно. При
  // пересчёте многих NFT с разными mint-временами это десятки последовательных
  // запросов — суммарно > таймаута вызывающей стороны, и поздние bucket'ы
  // (включая Velodrome) не успевали → цена null → cost basis $0. 5 запросов
  // в полёте: на порядок быстрее, при этом вежливо к DefiLlama (один JS-поток,
  // запись в cache/result между await'ами безопасна).
  const tsEntries = Array.from(byTs.entries());
  const CONCURRENCY = 5;
  let cursor = 0;
  const runWorker = async (): Promise<void> => {
    while (cursor < tsEntries.length) {
      if (signal?.aborted) return;
      const [ts, coins] = tsEntries[cursor++]!;
      const got = await fetchOneTs(ts, Array.from(coins), signal);
      for (const [coin, price] of got) {
        const k = cacheKeyFor(coin, ts);
        cache[k] = price;
        result.set(k, price);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, tsEntries.length) }, runWorker),
  );

  // 4. Сохраняем кэш.
  writeCache(cache);
  return result;
}
