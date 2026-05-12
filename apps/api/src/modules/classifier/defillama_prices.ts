/**
 * DefiLlama historical-prices fetch + in-memory cache — server port of
 * `fetchHistoricalPrices` from `apps/web/src/lib/defillama.ts` (P5.6).
 *
 * Differences from the web original:
 *   - No localStorage; cache is process-local Map.
 *   - Direct `https://coins.llama.fi` (no Vite proxy on backend).
 *   - Historical prices are immutable, so cache entries never expire
 *     during the process lifetime. Restarts clear it.
 *
 * Contract preserved: keys in the returned Map are `cacheKeyFor(coin, ts)`
 * (i.e. `${coin}|${bucketTs}`), matching `priceFromMap()` lookup.
 */

import { bucketTs, cacheKeyFor } from "./defillama_keys.js";

const BASE_URL =
  process.env["DEFILLAMA_BASE_URL"] ?? "https://coins.llama.fi";
const SEARCH_WIDTH = "4h";
const CHUNK_SIZE = 50;

/** Exported for tests / observability. */
export function defillamaBaseUrl(): string {
  return BASE_URL;
}

/** Process-local cache: `cacheKey → price`. */
const cache = new Map<string, number>();

export function __resetDefillamaCache(): void {
  cache.clear();
}

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
  signal?: AbortSignal
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (coins.length === 0) return out;
  for (let i = 0; i < coins.length; i += CHUNK_SIZE) {
    if (signal?.aborted) break;
    const chunk = coins.slice(i, i + CHUNK_SIZE);
    const url = `${BASE_URL}/prices/historical/${ts}/${chunk.join(",")}?searchWidth=${SEARCH_WIDTH}`;
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
        if (typeof v.price === "number" && v.price > 0) {
          out.set(coin, v.price);
        }
      }
    } catch {
      /* one chunk failed — keep going */
    }
  }
  return out;
}

/**
 * Fetch historical prices for a list of `(coin, timestamp)` pairs.
 *
 *   - Requests are grouped by hour bucket (`bucketTs(ts)`) and chunked
 *     into 50-coin URLs.
 *   - Cache hits short-circuit the fetch; misses are filled and stored.
 *   - Errors (non-OK status, network) are swallowed per-chunk.
 *
 * Returns a Map keyed by `cacheKeyFor(coin, ts)`. Caller looks up via
 * `priceFromMap(map, coin, timestamp)` from `defillama_keys.ts`.
 */
export async function fetchHistoricalPrices(
  items: { coin: string; timestamp: number }[],
  signal?: AbortSignal
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (items.length === 0) return result;

  // 1. Drain the cache.
  const need: { coin: string; tsBucket: number }[] = [];
  for (const it of items) {
    const k = cacheKeyFor(it.coin, it.timestamp);
    const cached = cache.get(k);
    if (cached != null) {
      result.set(k, cached);
    } else {
      need.push({ coin: it.coin, tsBucket: bucketTs(it.timestamp) });
    }
  }
  if (need.length === 0) return result;

  // 2. Group remaining by bucket, deduping coins within a bucket.
  const byTs = new Map<number, Set<string>>();
  for (const { coin, tsBucket } of need) {
    let s = byTs.get(tsBucket);
    if (!s) {
      s = new Set();
      byTs.set(tsBucket, s);
    }
    s.add(coin);
  }

  // 3. Sequential fetch per bucket — DefiLlama is free, no need to ddos.
  for (const [ts, coins] of byTs) {
    if (signal?.aborted) break;
    const got = await fetchOneTs(ts, Array.from(coins), signal);
    for (const [coin, price] of got) {
      const k = cacheKeyFor(coin, ts);
      cache.set(k, price);
      result.set(k, price);
    }
  }

  return result;
}
