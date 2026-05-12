/**
 * Персистентный кэш загруженных кошельков.
 *
 * Ключ: `capflow.cache.v${CACHE_VERSION}.wallet.${walletId}`
 *
 * **Versioning:** при каждом значимом изменении логики (классификатора,
 * адаптера балансов, фильтра спама и т.д.) поднимаем `CACHE_VERSION`.
 * Это автоматически инвалидирует старые кэши — пользователю не нужно
 * вручную чистить, при следующем заходе данные перезагрузятся с применением
 * новой логики.
 *
 * Что версионируется:
 *   v1 — initial
 *   v2 — Fluid lending, GMX → yield, GM/GLP filter, taint-tracker,
 *        Vybe + Sonar Solana DeFi sources, custom-event sync, internal
 *        transfer pair detection.
 *   v3 — `from`-метка из имени кошелька (не "Wallet"/"Binance").
 *   v4 — `transfer_in` без `sends` теперь генерирует ManualOp; bridges как
 *        полноценные buy-движения.
 *   v5 — `feePayer` поле в ClassifiedOp (для distinguishing user-claim
 *        vs auto-push reward). Расширенный спам-фильтр.
 *   v6 — fix: USD₮0 / USDT0 / USDC.e теперь корректно `isStable`. Свопы на
 *        1inch / KyberSwap / Uniswap V4, помеченные DeBank как `approve`,
 *        переклассифицируются в `swap`, если есть реальные in/out движения.
 */

const CACHE_VERSION = 6;
const PREFIX = `capflow.cache.v${CACHE_VERSION}.wallet.`;
const LEGACY_PREFIX = "capflow.cache.wallet.";

/** Удаляем устаревшие кэши при загрузке модуля. */
if (typeof localStorage !== "undefined") {
  try {
    const toDelete: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      // Удаляем legacy (без версии) и более ранние версии (cache.v1.*).
      if (
        k.startsWith(LEGACY_PREFIX) ||
        (k.startsWith("capflow.cache.v") && !k.startsWith(PREFIX))
      ) {
        toDelete.push(k);
      }
    }
    for (const k of toDelete) localStorage.removeItem(k);
    if (toDelete.length > 0) {
      // eslint-disable-next-line no-console
      console.info(
        `[capflow] cleaned ${toDelete.length} stale cache entries; using v${CACHE_VERSION}`,
      );
    }
  } catch {
    /* ignore */
  }
}

export function readWalletCache<T>(walletId: string): T | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(PREFIX + walletId);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeWalletCache<T>(walletId: string, value: T): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(PREFIX + walletId, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn(`Cache write failed for wallet ${walletId}:`, e);
    return false;
  }
}

export function deleteWalletCache(walletId: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(PREFIX + walletId);
  } catch {
    /* ignore */
  }
}

export function readAllWalletCacheIds(): string[] {
  if (typeof localStorage === "undefined") return [];
  const ids: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) ids.push(k.slice(PREFIX.length));
    }
  } catch {
    /* ignore */
  }
  return ids;
}

export function getCacheAgeMs(walletId: string): number | null {
  const cached = readWalletCache<{ loadedAt?: number }>(walletId);
  if (!cached?.loadedAt) return null;
  return Date.now() - cached.loadedAt;
}

export const CURRENT_CACHE_VERSION = CACHE_VERSION;
