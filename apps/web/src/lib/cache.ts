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
 *   v7 — DeBank spam-token фильтр (is_verified/is_core/is_wallet): airdrop-
 *        скам с фейковой high-price больше не попадает в live.tokens,
 *        Σ tokens.usd теперь совпадает с DeBank's authoritative
 *        total_usd_value. Лечит Bob's $539k phantom ($77k real).
 *   v8 — classifyProtocol теперь использует DefiLlama protocols catalog
 *        как fallback (после топ-50 PATTERNS, перед `category="other"`).
 *        Это решает scaling whitelist'а для unknown protocols. Бутстрап
 *        каталога — в main.tsx через loadLlamaProtocols(). Диагностический
 *        warn в build_open_position когда `opened === null` для V3 LP —
 *        для быстрого отладочного flow по POS-XXX issues.
 *   v9 — fix depositAmountSum: теперь считает **net** deposited
 *        (Σ supply.out − Σ withdraw.in) вместо Σ всех out-движений.
 *        Без минуса withdraw'ов supply-yield был отрицательным для
 *        long-running лендинг-позиций с partial-withdraw → fees=0
 *        (POS-003 via.irk). Также расширили rebase-style detection на
 *        restaking + liquid-staking категории (stETH, rETH и пр.).
 *   v10 — H5/H6/H7/H8/H9 financial-correctness batch (2026-05-14):
 *        — V3 pro-rata теперь per-NFT: больше не пропускает группу при
 *          1% sum-tolerance, individual offsetting errors теперь видны.
 *        — netPnlUsd = currentUsd − startUsd: убран double-subtraction
 *          долга (PnL — только collateral-side change).
 *        — transfer_in принимается как acquire-lot, когда есть надёжная
 *          DefiLlama hist-цена. Раньше CEX-withdraw → supply раздувал
 *          uncoveredAmount = current → PnL = 0 навсегда.
 *        — depositAmountSum теперь обязательно фильтрует по chain.
 *          Multi-chain Aave V3 (Polygon+Arb+ETH под одним protocol.id)
 *          больше не суммируется в общий deposited.
 *        — DeBank spam-filter closed-by-default + $1000 cap на
 *          unflagged tokens — защита от регрессии Bob's $539k phantom.
 *   v12 — История: добавлено поле `historyComplete` в payload `Loaded`.
 *        Старый кэш (без флага) трактуется как «бэкфилл не завершён» → при
 *        следующем заходе история догружается до конца (полный бэкфилл),
 *        затем переходит на дешёвый инкремент (несколько страниц). Бамп
 *        версии нужен, чтобы не считать legacy-кэш «полным» по ошибке.
 *   v11 — M7 (2026-05-14): per-user namespacing.
 *        Key format: `capflow.cache.v11.user.<userId>.wallet.<walletId>`.
 *        Защищает от cross-user data leak на shared-device, impersonation
 *        switch, повторных логинов разных юзеров в одном браузере.
 *        Раньше ключ был `capflow.cache.v10.wallet.<walletId>` —
 *        вторая идентичность могла случайно прочесть кэш первой,
 *        пока explicit cleanup на user-change не отрабатывал.
 */

const CACHE_VERSION = 12;
const BASE_PREFIX = `capflow.cache.v${CACHE_VERSION}.`;
const LEGACY_PREFIX = "capflow.cache.wallet.";

/**
 * Per-user cache scope. Set via `setCacheUserScope(userId)` on auth
 * change (login, impersonation start/end). Cache operations are
 * **no-ops** until a userId is set — this is intentional: if no user
 * is logged in, we shouldn't be writing wallet data anywhere.
 */
let currentUserId: string | null = null;

export function setCacheUserScope(userId: string | null): void {
  currentUserId = userId;
}

function prefixFor(): string | null {
  if (!currentUserId) return null;
  return `${BASE_PREFIX}user.${currentUserId}.wallet.`;
}

/** Удаляем устаревшие кэши при загрузке модуля. */
if (typeof localStorage !== "undefined") {
  // L5 (2026-05-14): skip the cleanup scan when we've already done it
  // for this version. Pre-L5 the loop walked ALL localStorage entries
  // on every page load (including unrelated sites' keys for power
  // users) — 1-5ms blocked main thread per navigation. Stamping a
  // version-keyed flag lets the cleanup run exactly once per version
  // bump per browser; clearing the flag on a `CACHE_VERSION` bump
  // happens automatically because the flag key includes the version.
  const CLEANUP_DONE_KEY = `capflow.cache.cleanup_done.v${CACHE_VERSION}`;
  try {
    if (!localStorage.getItem(CLEANUP_DONE_KEY)) {
      const toDelete: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        // Удаляем legacy (без версии) и более ранние версии (cache.v1.* … v10.*).
        if (
          k.startsWith(LEGACY_PREFIX) ||
          (k.startsWith("capflow.cache.v") && !k.startsWith(BASE_PREFIX))
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
      localStorage.setItem(CLEANUP_DONE_KEY, "1");
    }
  } catch {
    /* ignore */
  }
}

export function readWalletCache<T>(walletId: string): T | null {
  if (typeof localStorage === "undefined") return null;
  const prefix = prefixFor();
  if (!prefix) return null;
  try {
    const raw = localStorage.getItem(prefix + walletId);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeWalletCache<T>(walletId: string, value: T): boolean {
  if (typeof localStorage === "undefined") return false;
  const prefix = prefixFor();
  if (!prefix) return false;
  try {
    localStorage.setItem(prefix + walletId, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn(`Cache write failed for wallet ${walletId}:`, e);
    return false;
  }
}

export function deleteWalletCache(walletId: string): void {
  if (typeof localStorage === "undefined") return;
  const prefix = prefixFor();
  if (!prefix) return;
  try {
    localStorage.removeItem(prefix + walletId);
  } catch {
    /* ignore */
  }
}

export function readAllWalletCacheIds(): string[] {
  if (typeof localStorage === "undefined") return [];
  const prefix = prefixFor();
  if (!prefix) return [];
  const ids: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) ids.push(k.slice(prefix.length));
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
