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
 */

const PROXY = "/defillama";
const CACHE_KEY = "capflow.cache.defillama.v1";
const SEARCH_WIDTH = "4h";
const HOUR = 3600;

/** Округление timestamp вниз до часа — для дедупликации запросов. */
function bucketTs(ts: number): number {
  return Math.floor(ts / HOUR) * HOUR;
}

/* ---------------------- mapping chain/token → coin ---------------------- */

/**
 * Нативный токен сети → его DefiLlama-coin id. Native ETH у нас в DeBank
 * приходит с `tokenId === chain` (например `tokenId: "arb"`, `chain: "arb"`).
 */
const NATIVE_COIN: Record<string, string> = {
  eth: "coingecko:ethereum",
  arb: "arbitrum:0x0000000000000000000000000000000000000000",
  op: "optimism:0x0000000000000000000000000000000000000000",
  base: "base:0x0000000000000000000000000000000000000000",
  matic: "polygon:0x0000000000000000000000000000000000001010",
  bsc: "bsc:0x0000000000000000000000000000000000000000",
  avax: "avax:0x0000000000000000000000000000000000000000",
  ftm: "fantom:0x0000000000000000000000000000000000000000",
  sol: "coingecko:solana",
};

const CHAIN_TO_LLAMA: Record<string, string> = {
  // Top-tier EVM
  eth: "ethereum",
  arb: "arbitrum",
  op: "optimism",
  base: "base",
  matic: "polygon",
  bsc: "bsc",
  avax: "avax",
  ftm: "fantom",
  // Расширенный список — DefiLlama поддерживает ~150 chains.
  // DeBank chain codes → DefiLlama chain names.
  linea: "linea",
  scrl: "scroll",
  blast: "blast",
  zksync: "era",
  zora: "zora",
  metis: "metis",
  manta: "manta",
  mode: "mode",
  mnt: "mantle",
  cro: "cronos",
  klay: "klaytn",
  kava: "kava",
  celo: "celo",
  moonbeam: "moonbeam",
  moonriver: "moonriver",
  hmy: "harmony",
  okt: "okexchain",
  movr: "moonriver",
  glmr: "moonbeam",
  bera: "berachain",
  sonic: "sonic",
  unichain: "unichain",
  hype: "hyperliquid",
  hyper: "hyperliquid",
  abs: "abstract",
  apechain: "apechain",
  taiko: "taiko",
  // Non-EVM
  sol: "solana",
};

/**
 * Map (chain, tokenId, symbol) → DefiLlama coin id, или null если не знаем.
 *
 *  - `tokenId === chain` → нативный токен сети (Native ETH, MATIC, SOL).
 *  - EVM-адрес контракта (`0x...`) → `{llamaChain}:{address}`
 *  - Solana mint (base58) → `solana:{mint}`
 */
export function defillamaCoinKey(
  chain: string,
  tokenId: string | null | undefined,
  symbol?: string,
): string | null {
  if (!tokenId) return null;
  // Native: tokenId совпадает с chain.
  if (tokenId === chain) {
    return NATIVE_COIN[chain] ?? null;
  }
  if (tokenId === "eth") return NATIVE_COIN.eth!;
  // EUR-pegged stablecoins: используем CoinGecko EUR feed (универсальный
  // EUR/USD rate) ВМЕСТО chain-specific contract. Иначе DefiLlama для
  // EURC на Base/etc. может не иметь цен → fallback на DeBank current
  // spot ($1.00 — неверно для EUR-pegged tokens).
  if (symbol) {
    const sym = symbol.toUpperCase();
    if (sym === "EURC" || sym === "EUROC") return "coingecko:euro-coin";
    if (sym === "EURE") return "coingecko:monerium-eur-money";
    if (sym === "EURS") return "coingecko:stasis-eurs";
    if (sym === "EURT") return "coingecko:tether-eurt";
    if (sym === "AGEUR") return "coingecko:ageur";
    if (sym === "EURI") return "coingecko:eurite";
  }
  // EVM address
  if (/^0x[0-9a-fA-F]{40}$/.test(tokenId)) {
    const llamaChain = CHAIN_TO_LLAMA[chain];
    if (!llamaChain) return null;
    return `${llamaChain}:${tokenId.toLowerCase()}`;
  }
  // Solana mint (base58 ~ 32-44 chars)
  if (chain === "sol" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tokenId)) {
    return `solana:${tokenId}`;
  }
  // Fallback по symbol — некоторые DeBank tokenIds выглядят как `{chain}_{contract}` или просто prefix.
  if (symbol) {
    const sym = symbol.toUpperCase();
    if (sym === "ETH" || sym === "WETH") return NATIVE_COIN.eth!;
    if (sym === "SOL") return NATIVE_COIN.sol!;
    if (sym === "BTC" || sym === "WBTC") return "coingecko:bitcoin";
  }
  return null;
}

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

const cacheKeyFor = (coin: string, ts: number) => `${coin}|${bucketTs(ts)}`;

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

  // 3. Делаем запросы — последовательно, чтобы не ддосить (DefiLlama бесплатный).
  for (const [ts, coins] of byTs) {
    if (signal?.aborted) break;
    const got = await fetchOneTs(ts, Array.from(coins), signal);
    for (const [coin, price] of got) {
      const k = cacheKeyFor(coin, ts);
      cache[k] = price;
      result.set(k, price);
    }
  }

  // 4. Сохраняем кэш.
  writeCache(cache);
  return result;
}

/** Хелпер: достать цену по `(coin, timestamp)` из ранее загруженного результата. */
export function priceFromMap(
  map: Map<string, number>,
  coin: string,
  timestamp: number,
): number | null {
  const k = cacheKeyFor(coin, timestamp);
  return map.get(k) ?? null;
}

/**
 * UCB D9: fallback к ближайшему по времени bucket'у для того же coin'а.
 *
 * DefiLlama hist-цены — sparse: для редких токенов или экстремальных дат
 * может не быть exact-bucket match'а, и `priceFromMap` возвращает null.
 * Это приводит к unknown cost basis для transfer_in / bridge_in / claim.
 *
 * Эта функция расширяет lookup: если exact miss, ищем ближайший bucket
 * ±maxOffsetHours (default 7 days = 168h). Возвращает цену из ближайшего
 * найденного bucket'а; null если ни одного в окне.
 *
 * Не используется для time-sensitive расчётов (PnL, fees APR), только
 * для cost basis fallback — где иметь approximate price лучше чем 0.
 */
export function priceFromMapNearest(
  map: Map<string, number>,
  coin: string,
  timestamp: number,
  maxOffsetHours = 24 * 7,
): { readonly price: number; readonly offsetHours: number } | null {
  // Fast-path: exact hit.
  const exact = priceFromMap(map, coin, timestamp);
  if (exact != null && exact > 0) return { price: exact, offsetHours: 0 };

  const targetBucket = bucketTs(timestamp);
  const prefix = `${coin}|`;
  let best: { price: number; offsetHours: number } | null = null;

  // Linear scan по ключам — O(n_buckets). Для типичной session (~100-500
  // pairs) практически instant. Если в будущем станет hot — построим
  // per-coin sorted index в init-time.
  for (const [k, v] of map) {
    if (!k.startsWith(prefix)) continue;
    if (v <= 0) continue;
    const bucket = Number(k.slice(prefix.length));
    if (!Number.isFinite(bucket)) continue;
    const offsetHours = Math.abs(bucket - targetBucket) / HOUR;
    if (offsetHours > maxOffsetHours) continue;
    if (!best || offsetHours < best.offsetHours) {
      best = { price: v, offsetHours };
    }
  }
  return best;
}
