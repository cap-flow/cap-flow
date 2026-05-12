/**
 * Jupiter Token API — метаданные SPL-токенов (symbol, name, decimals, logo).
 *
 * Используется для **неизвестных** SPL-mint'ов: когда Helius вернул токен
 * без symbol (или с raw mint в качестве «symbol»), и его нет в нашем
 * курируемом списке `SPL_TOKENS`. Раньше такие токены отображались как
 * `Dqq5…2eB8` и часто отбрасывались по dust-фильтру (нет цены).
 *
 * Endpoint: `https://tokens.jup.ag/token/{mint}` (раньше `lite-api`).
 * Возвращает 200 OK с JSON или 404 если mint неизвестен.
 *
 * Кэш — localStorage `capflow.jup_token_meta` (Map<mint, JupTokenMeta | null>).
 * `null` означает «Jupiter ничего не знает», чтобы не делать повторных
 * запросов на тот же mint в течение сессии.
 */

const ENDPOINT = "https://tokens.jup.ag/token/";
const CACHE_KEY = "capflow.jup_token_meta";
const CACHE_VERSION = 1;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 дней

export interface JupTokenMeta {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  logoURI?: string;
  tags?: string[];
}

interface CacheEntry {
  meta: JupTokenMeta | null;
  fetchedAt: number;
}

interface CacheShape {
  v: number;
  byMint: Record<string, CacheEntry>;
}

function loadCache(): CacheShape {
  if (typeof window === "undefined") return { v: CACHE_VERSION, byMint: {} };
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return { v: CACHE_VERSION, byMint: {} };
    const parsed = JSON.parse(raw) as CacheShape;
    if (parsed.v !== CACHE_VERSION) return { v: CACHE_VERSION, byMint: {} };
    return parsed;
  } catch {
    return { v: CACHE_VERSION, byMint: {} };
  }
}

function saveCache(cache: CacheShape) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* quota exceeded — ignore */
  }
}

function isFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.fetchedAt < CACHE_TTL_MS;
}

/**
 * Запросить метаданные одного mint'а.
 * Кэширует результат на 7 дней (включая null-результаты).
 */
export async function fetchJupiterTokenMeta(
  mint: string,
  signal?: AbortSignal,
): Promise<JupTokenMeta | null> {
  const cache = loadCache();
  const cached = cache.byMint[mint];
  if (cached && isFresh(cached)) return cached.meta;

  try {
    const res = await fetch(
      ENDPOINT + encodeURIComponent(mint),
      signal ? { signal } : {},
    );
    if (res.status === 404) {
      cache.byMint[mint] = { meta: null, fetchedAt: Date.now() };
      saveCache(cache);
      return null;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const meta = (await res.json()) as JupTokenMeta;
    cache.byMint[mint] = { meta, fetchedAt: Date.now() };
    saveCache(cache);
    return meta;
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    // Сетевая ошибка / невалидный JSON — кэшируем как null чтобы не
    // долбить тот же mint каждую секунду.
    cache.byMint[mint] = { meta: null, fetchedAt: Date.now() };
    saveCache(cache);
    return null;
  }
}

/**
 * Batch-запрос для списка mint'ов. Делает параллельные fetch'и (с лимитом),
 * результаты кэшируются. Возвращает Map<mint, meta | null>.
 */
export async function fetchJupiterTokenMetaBatch(
  mints: string[],
  signal?: AbortSignal,
): Promise<Map<string, JupTokenMeta | null>> {
  const out = new Map<string, JupTokenMeta | null>();
  if (mints.length === 0) return out;

  const cache = loadCache();
  const toFetch: string[] = [];
  for (const mint of mints) {
    const cached = cache.byMint[mint];
    if (cached && isFresh(cached)) {
      out.set(mint, cached.meta);
    } else {
      toFetch.push(mint);
    }
  }

  // Лимит параллельности — 6, чтобы не словить rate-limit.
  const CONCURRENCY = 6;
  for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
    const batch = toFetch.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (mint) => {
        try {
          return [mint, await fetchJupiterTokenMeta(mint, signal)] as const;
        } catch (e) {
          if ((e as Error).name === "AbortError") throw e;
          return [mint, null] as const;
        }
      }),
    );
    for (const [mint, meta] of results) out.set(mint, meta);
  }

  return out;
}
