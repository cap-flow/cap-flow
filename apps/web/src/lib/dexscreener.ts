/**
 * DEX Screener API — универсальный fallback для цен и metadata любых токенов.
 *
 * Зачем: когда primary провайдер цен (Jupiter Price для Solana, DeBank для
 * EVM) не возвращает цену для токена, мы получаем `usd = 0` и токен
 * отбрасывается dust-фильтром. DEX Screener агрегирует **все DEX-пулы**
 * по любому контракт-адресу и отдаёт цену из самого ликвидного пула.
 *
 * Особенности:
 *   - **Без API-ключа** — публичный endpoint, без регистрации.
 *   - **Все сети** — Solana, Ethereum, Arbitrum, Optimism, Base, Polygon,
 *     BSC, Avalanche, Fantom, Linea, Scroll, Mantle и т.д.
 *   - **Soft rate-limit** — 300 req/min без ключа. Кэшируем на 10 минут.
 *   - **Liquidity-weighted** — берём пул с максимальным liquidityUSD,
 *     иначе мелкие пулы с rugpull-ценами могут испортить котировку.
 *
 * Endpoint: `https://api.dexscreener.com/latest/dex/tokens/{address}`
 * Возвращает массив `pairs[]` от всех DEX где этот токен торгуется.
 */

const ENDPOINT = "https://api.dexscreener.com/latest/dex/tokens/";
const CACHE_KEY = "capflow.dexscreener_prices";
const CACHE_VERSION = 1;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 минут — цены актуальны
const NULL_TTL_MS = 60 * 60 * 1000; // 1 час — реже долбим неизвестные токены

export interface DexScreenerToken {
  address: string;
  /** USD price из ликвиднейшего пула. */
  priceUsd: number;
  /** Сумма liquidityUSD всех пулов (грубая оценка глубины). */
  liquidityUsd: number;
  /** Symbol из самого ликвидного пула. */
  symbol: string;
  /** Полное имя если возвращено DEX'ом. */
  name?: string;
  /** Сеть (от DEX Screener — нормализованная: solana, ethereum, arbitrum, …). */
  chainId: string;
}

interface CacheEntry {
  data: DexScreenerToken | null;
  fetchedAt: number;
}

interface CacheShape {
  v: number;
  byAddress: Record<string, CacheEntry>;
}

interface RawPair {
  chainId: string;
  baseToken: { address: string; name?: string; symbol: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
}

interface RawResponse {
  pairs: RawPair[] | null;
}

function loadCache(): CacheShape {
  if (typeof window === "undefined") return { v: CACHE_VERSION, byAddress: {} };
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return { v: CACHE_VERSION, byAddress: {} };
    const parsed = JSON.parse(raw) as CacheShape;
    if (parsed.v !== CACHE_VERSION) return { v: CACHE_VERSION, byAddress: {} };
    return parsed;
  } catch {
    return { v: CACHE_VERSION, byAddress: {} };
  }
}

function saveCache(cache: CacheShape) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* ignore quota */
  }
}

function isFresh(entry: CacheEntry): boolean {
  const ttl = entry.data ? CACHE_TTL_MS : NULL_TTL_MS;
  return Date.now() - entry.fetchedAt < ttl;
}

function pickBestPair(pairs: RawPair[]): RawPair | null {
  if (pairs.length === 0) return null;
  // Берём пул с наибольшим liquidityUSD — это даёт устойчивую цену.
  let best: RawPair | null = null;
  let bestLiq = 0;
  for (const p of pairs) {
    const liq = p.liquidity?.usd ?? 0;
    if (liq >= bestLiq) {
      best = p;
      bestLiq = liq;
    }
  }
  return best;
}

export async function fetchDexScreenerToken(
  address: string,
  signal?: AbortSignal,
): Promise<DexScreenerToken | null> {
  const cache = loadCache();
  const cached = cache.byAddress[address];
  if (cached && isFresh(cached)) return cached.data;

  try {
    const res = await fetch(
      ENDPOINT + encodeURIComponent(address),
      signal ? { signal } : {},
    );
    if (!res.ok) {
      cache.byAddress[address] = { data: null, fetchedAt: Date.now() };
      saveCache(cache);
      return null;
    }
    const json = (await res.json()) as RawResponse;
    const pairs = json.pairs ?? [];
    const best = pickBestPair(pairs);
    if (!best || !best.priceUsd) {
      cache.byAddress[address] = { data: null, fetchedAt: Date.now() };
      saveCache(cache);
      return null;
    }
    const priceUsd = Number(best.priceUsd);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
      cache.byAddress[address] = { data: null, fetchedAt: Date.now() };
      saveCache(cache);
      return null;
    }
    // Σ liquidity всех пулов — для UI/диагностики.
    let totalLiq = 0;
    for (const p of pairs) totalLiq += p.liquidity?.usd ?? 0;

    const data: DexScreenerToken = {
      address: best.baseToken.address,
      priceUsd,
      liquidityUsd: totalLiq,
      symbol: best.baseToken.symbol,
      ...(best.baseToken.name ? { name: best.baseToken.name } : {}),
      chainId: best.chainId,
    };
    cache.byAddress[address] = { data, fetchedAt: Date.now() };
    saveCache(cache);
    return data;
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    cache.byAddress[address] = { data: null, fetchedAt: Date.now() };
    saveCache(cache);
    return null;
  }
}

/**
 * Batch-запрос для списка адресов. Использует public batch endpoint
 * (до 30 адресов через запятую за один запрос).
 */
export async function fetchDexScreenerTokenBatch(
  addresses: string[],
  signal?: AbortSignal,
): Promise<Map<string, DexScreenerToken | null>> {
  const out = new Map<string, DexScreenerToken | null>();
  if (addresses.length === 0) return out;

  const cache = loadCache();
  const toFetch: string[] = [];
  for (const addr of addresses) {
    const cached = cache.byAddress[addr];
    if (cached && isFresh(cached)) {
      out.set(addr, cached.data);
    } else {
      toFetch.push(addr);
    }
  }

  // Endpoint поддерживает comma-separated list. Берём по 30 за раз.
  const BATCH_SIZE = 30;
  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const batch = toFetch.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetch(
        ENDPOINT + batch.map(encodeURIComponent).join(","),
        signal ? { signal } : {},
      );
      if (!res.ok) {
        for (const a of batch) {
          cache.byAddress[a] = { data: null, fetchedAt: Date.now() };
          out.set(a, null);
        }
        continue;
      }
      const json = (await res.json()) as RawResponse;
      const allPairs = json.pairs ?? [];
      // Группируем pairs по baseToken.address.
      const byAddr = new Map<string, RawPair[]>();
      for (const p of allPairs) {
        const a = p.baseToken.address;
        const arr = byAddr.get(a) ?? [];
        arr.push(p);
        byAddr.set(a, arr);
      }
      for (const a of batch) {
        const pairs = byAddr.get(a) ?? [];
        const best = pickBestPair(pairs);
        if (!best || !best.priceUsd) {
          cache.byAddress[a] = { data: null, fetchedAt: Date.now() };
          out.set(a, null);
          continue;
        }
        const priceUsd = Number(best.priceUsd);
        if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
          cache.byAddress[a] = { data: null, fetchedAt: Date.now() };
          out.set(a, null);
          continue;
        }
        let totalLiq = 0;
        for (const p of pairs) totalLiq += p.liquidity?.usd ?? 0;
        const data: DexScreenerToken = {
          address: best.baseToken.address,
          priceUsd,
          liquidityUsd: totalLiq,
          symbol: best.baseToken.symbol,
          ...(best.baseToken.name ? { name: best.baseToken.name } : {}),
          chainId: best.chainId,
        };
        cache.byAddress[a] = { data, fetchedAt: Date.now() };
        out.set(a, data);
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      for (const a of batch) {
        cache.byAddress[a] = { data: null, fetchedAt: Date.now() };
        out.set(a, null);
      }
    }
  }

  saveCache(cache);
  return out;
}
