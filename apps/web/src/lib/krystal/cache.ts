/**
 * localStorage cache для Krystal Cloud V3 positions (PR-K4).
 *
 * Без кэша каждый page reload жжёт 10 credits/wallet × N wallets. У lex@
 * 2 wallet'а → 20 credits/reload. 100 reloads/день = 2000 credits/день на
 * одного пользователя. Free tier обычно 1-10k/месяц, исчерпываем за 1 день.
 *
 * Cache TTL: 24h. V3 LP current state меняется медленно (юзер редко двигает
 * liquidity), для display целей day-old data accuracy ~1% (price drift).
 * Manual refresh — через `clearKrystalCacheForWallet()` (UI button — PR-K5).
 *
 * Storage layout:
 *   `capflow.cache.krystal.v1:<wallet_lowercase>` → JSON entry
 *
 * Версионирование: `.v1` в префиксе позволяет при breaking change schema
 * добавить `.v2` хэндлер и invalidate'ить старые entries.
 */

import type { KrystalPosition } from "./types";

const CACHE_PREFIX = "capflow.cache.krystal.v1:";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

interface CacheEntry {
  walletAddress: string;
  positions: KrystalPosition[];
  fetchedAt: number; // unix ms
}

function cacheKey(walletAddress: string): string {
  return `${CACHE_PREFIX}${walletAddress.toLowerCase()}`;
}

function safeLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Прочитать cache entry для wallet'а. Возвращает positions[] если entry
 * fresh (≤ TTL); иначе `null`. Никогда не throws — corrupted JSON,
 * missing fields, storage unavailable → null.
 */
export function readKrystalCache(walletAddress: string): KrystalPosition[] | null {
  const ls = safeLocalStorage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(cacheKey(walletAddress));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CacheEntry>;
    if (
      typeof parsed.fetchedAt !== "number" ||
      !Array.isArray(parsed.positions)
    ) {
      return null;
    }
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
    return parsed.positions as KrystalPosition[];
  } catch {
    return null;
  }
}

/**
 * Записать positions в cache для wallet'а. Не throws — quota/storage
 * errors молча игнорируются (cache best-effort).
 */
export function writeKrystalCache(
  walletAddress: string,
  positions: KrystalPosition[],
): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    const entry: CacheEntry = {
      walletAddress: walletAddress.toLowerCase(),
      positions,
      fetchedAt: Date.now(),
    };
    ls.setItem(cacheKey(walletAddress), JSON.stringify(entry));
  } catch {
    /* quota exceeded — drop */
  }
}

/**
 * Очистить cache для одного wallet'а. Для UI кнопки «обновить Krystal»
 * этого wallet'а / при detected stale data.
 */
export function clearKrystalCacheForWallet(walletAddress: string): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    ls.removeItem(cacheKey(walletAddress));
  } catch {
    /* ignore */
  }
}

/**
 * Очистить все Krystal entries. Для global "Refresh Krystal" / version bump.
 * НЕ трогает другие capflow.* keys (только префикс `capflow.cache.krystal.v1:`).
 */
export function clearAllKrystalCache(): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.startsWith(CACHE_PREFIX)) toRemove.push(k);
    }
    for (const k of toRemove) ls.removeItem(k);
  } catch {
    /* ignore */
  }
}
