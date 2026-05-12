/**
 * CoinGecko historical prices — для V3 mint'ов на момент tx timestamp.
 *
 * **Зачем нужно**: Revert Finance использует именно этот источник
 * (см. docs.revert.finance/revert/position-analytics) для расчёта
 * "Initial Deposit Value" и "Current Value". Их цены = aggregator
 * (volume-weighted среди многих CEX/DEX) в minute/hour bucket'е, что
 * отличается от любого on-chain pool slot0 на 0.03-0.20%.
 *
 * Метод: `/coins/{platform}/contract/{contract}/market_chart/range`
 * возвращает массив [timestamp_ms, price_usd] с 5-минутной точностью
 * для последних 90 дней (и часовой/дневной для более старых).
 *
 * Free tier: ~30 calls/min, без API key. Caching обязательный.
 */

/**
 * Маппинг наших chain code'ов в CoinGecko platform ID'ы.
 *
 * Смотри https://api.coingecko.com/api/v3/asset_platforms — id field.
 */
const PLATFORM_BY_CHAIN: Record<string, string> = {
  eth: "ethereum",
  arb: "arbitrum-one",
  op: "optimistic-ethereum",
  base: "base",
  matic: "polygon-pos",
  bsc: "binance-smart-chain",
  avax: "avalanche",
  ftm: "fantom",
  cro: "cronos",
  metis: "metis-andromeda",
  scrl: "scroll",
  linea: "linea",
  blast: "blast",
  zora: "zora-network",
  // Native ETH placeholder — используется DeBank'ом для native токена.
  // CoinGecko: id = "ethereum" (но это для платформы; для native ETH
  // самой используется coin id "ethereum"). Нативный ETH запросим
  // через `/coins/ethereum/market_chart/range` если adress = 0xeeee...
};

/**
 * Native токены (используются как placeholder для native asset'а в DeBank).
 * Маппинг chain code → coingecko coin id.
 */
const NATIVE_COIN_BY_CHAIN: Record<string, string> = {
  eth: "ethereum",
  arb: "ethereum", // arb's native = ETH (gas)
  op: "ethereum",
  base: "ethereum",
  matic: "matic-network",
  bsc: "binancecoin",
  avax: "avalanche-2",
};

/** Адреса считающиеся native ETH placeholder'ом. */
const NATIVE_ADDRESSES = new Set([
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "0x0000000000000000000000000000000000000000",
]);

const CACHE_KEY = "capflow.cache.coingecko.v1";
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000; // 30 дней — исторические цены неизменны

interface CacheEntry {
  /** Цена в USD на запрошенный timestamp (ближайшая точка). */
  price: number;
  /** Когда сохранили (для TTL invalidation). */
  ts: number;
}

type Cache = Record<string, CacheEntry>;

function readCache(): Cache {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Cache;
  } catch {
    return {};
  }
}

function writeCache(c: Cache): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    /* quota — игнорируем */
  }
}

/**
 * Округляем timestamp до 5-минутного bucket'а (CoinGecko's resolution для
 * последних 90 дней). Для более старых дат — до часа.
 */
function bucketTimestamp(timestamp: number): number {
  const ageDays = (Date.now() / 1000 - timestamp) / 86_400;
  if (ageDays < 90) return Math.floor(timestamp / 300) * 300; // 5-min
  return Math.floor(timestamp / 3600) * 3600; // 1-hour
}

function cacheKey(chain: string, address: string, timestamp: number): string {
  const bucket = bucketTimestamp(timestamp);
  return `${chain}|${address.toLowerCase()}|${bucket}`;
}

/**
 * Circuit breaker: если получили 3 подряд 429 — отключаем CoinGecko на
 * ближайшие 5 минут и сразу возвращаем null. Public free tier rate-limit
 * реально ~5-10 calls/min независимо от throttling — без Pro API key
 * это unusable.
 */
let consecutive429s = 0;
let circuitOpenUntil = 0;
const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;

/** Pro API key (опционально). Читаем из localStorage — пользователь может вписать в Settings → Integrations. */
function getApiKey(): string | null {
  try {
    return localStorage.getItem("capflow.coingecko.apiKey") || null;
  } catch {
    return null;
  }
}

/**
 * Получить USD цену токена на конкретный timestamp через CoinGecko.
 *
 * Возвращает ближайшую (по времени) точку из CoinGecko'shкого
 * `market_chart/range` ответа. Кэш в localStorage по 5-min/1-hour bucket'ам.
 *
 * Возвращает null если:
 *   - chain не маппится на CoinGecko platform
 *   - токен не известен CoinGecko'у (новый, listed только на DEX'е)
 *   - rate-limit (429) — try later
 *   - сетевая ошибка
 *   - circuit breaker открыт (slishком много 429s подряд)
 */
export async function fetchCoinGeckoPriceAt(
  chainCode: string,
  contractAddress: string,
  timestamp: number,
): Promise<number | null> {
  if (Date.now() < circuitOpenUntil) return null;
  const cache = readCache();
  const cKey = cacheKey(chainCode, contractAddress, timestamp);
  const cached = cache[cKey];
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.price;
  }

  const isNative = NATIVE_ADDRESSES.has(contractAddress.toLowerCase());
  let url: string;
  // Окно ±5 минут вокруг target timestamp — даёт 1-2 точки для 5-min granularity.
  const fromTs = timestamp - 300;
  const toTs = timestamp + 300;

  if (isNative) {
    const coinId = NATIVE_COIN_BY_CHAIN[chainCode];
    if (!coinId) return null;
    url = `/coingecko/coins/${coinId}/market_chart/range?vs_currency=usd&from=${fromTs}&to=${toTs}`;
  } else {
    const platform = PLATFORM_BY_CHAIN[chainCode];
    if (!platform) return null;
    url = `/coingecko/coins/${platform}/contract/${contractAddress.toLowerCase()}/market_chart/range?vs_currency=usd&from=${fromTs}&to=${toTs}`;
  }

  // Pro API key (если есть) — добавляем header для увеличения rate-limit'а.
  const apiKey = getApiKey();
  const init: RequestInit = apiKey
    ? { headers: { "x-cg-pro-api-key": apiKey } }
    : {};
  try {
    const resp = await fetch(url, init);
    if (!resp.ok) {
      // 429 rate-limit, 404 unknown token, etc.
      if (resp.status === 429) {
        consecutive429s++;
        if (consecutive429s >= CIRCUIT_THRESHOLD) {
          circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
          console.warn(
            `[CoinGecko] circuit OPEN: ${CIRCUIT_THRESHOLD} consecutive 429s. ` +
              `Pausing CoinGecko for 5 min. ` +
              `For exact Revert match — add Pro API key in Settings → Integrations.`,
          );
        } else {
          console.warn(`[CoinGecko] rate-limited for ${chainCode}|${contractAddress}`);
        }
      }
      return null;
    }
    // Успех — сбрасываем счётчик 429.
    consecutive429s = 0;
    const data = (await resp.json()) as { prices?: [number, number][] };
    if (!data.prices || data.prices.length === 0) return null;

    // Берём ближайшую к timestamp точку.
    const targetMs = timestamp * 1000;
    let best = data.prices[0]!;
    let bestDist = Math.abs(best[0] - targetMs);
    for (const p of data.prices) {
      const d = Math.abs(p[0] - targetMs);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    const price = best[1];
    // Кэшируем.
    cache[cKey] = { price, ts: Date.now() };
    writeCache(cache);
    return price;
  } catch (e) {
    console.warn(
      `[CoinGecko] fetch failed for ${chainCode}|${contractAddress}:`,
      (e as Error).message,
    );
    return null;
  }
}

/**
 * Bulk: для списка (chain, address, timestamp) запросов — последовательно
 * через fetchCoinGeckoPriceAt (с кэшем).
 *
 * **Rate-limit стратегия**: free tier CoinGecko = ~10-30 calls/min.
 * Делаем 1 запрос за раз с 2.5 сек задержкой → ~24 calls/min, безопасно.
 * Закэшированные пропускаем мгновенно (cache hit'ы не считаются как RPC).
 *
 * Если хочется быстрее — нужен Pro API key (500 calls/min, $129/month).
 * Пока без ключа fallback на slot0 для тех токенов где CoinGecko вернул null.
 */
export async function fetchCoinGeckoPricesBulk(
  requests: { chainCode: string; address: string; timestamp: number }[],
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < requests.length; i++) {
    if (signal?.aborted) return out;
    const r = requests[i]!;
    // Сначала проверяем кэш — мгновенный возврат без задержки.
    const cKey = cacheKey(r.chainCode, r.address, r.timestamp);
    const cache = readCache();
    const cached = cache[cKey];
    let price: number | null = null;
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      price = cached.price;
    } else {
      // Live RPC — соблюдаем rate-limit (2.5s между запросами).
      price = await fetchCoinGeckoPriceAt(r.chainCode, r.address, r.timestamp);
      // Задержка ТОЛЬКО после реального RPC (не после cache hit'а).
      if (i < requests.length - 1) {
        await new Promise((res) => setTimeout(res, 2500));
      }
    }
    if (price != null && price > 0) {
      const key = `${r.chainCode}|${r.address.toLowerCase()}|${r.timestamp}`;
      out.set(key, price);
    }
  }
  return out;
}

export function coinGeckoBulkKey(
  chainCode: string,
  address: string,
  timestamp: number,
): string {
  return `${chainCode}|${address.toLowerCase()}|${timestamp}`;
}
