/**
 * Capflow feature flags — двухуровневая система:
 *
 * 1. **Server-side flags** (`feature_flags` table в БД, resolve через
 *    `/me/feature-flags` API) — приоритетные. Admin управляет через
 *    `/admin/feature-flags`: user-scope → account-scope → global. Раскатка
 *    идёт: «себе» (user-scope) → «нескольким бета-юзерам» (user-scope) →
 *    «всем» (global=true).
 *
 * 2. **Client-side flags** (localStorage, dev-only) — fallback когда
 *    server flag не задан. Полезно для DevTools-only experiments которые
 *    не нужно делать видимыми всем пользователям сервиса.
 *
 * Резолв order для конкретного юзера:
 *    user-scope server  → account-scope server → global server →
 *      → client localStorage → default(false)
 *
 * Use cases:
 *  - Production rollout (видно всем юзерам, sync через server) → server-flag
 *  - Local dev experiment (только в этом браузере) → client-flag
 *
 * Реактивность: server-flag через `useResolvedFeatureFlag(key)` hook
 * автоматически re-renders при invalidation; client-flag — после `reload()`.
 */

export interface ClientFeatureFlag {
  /** localStorage ключ. */
  key: string;
  /** Короткий human-readable label для UI checkbox. */
  label: string;
  /** Подробное описание что флаг делает + предупреждения. */
  description: string;
  /** Default value когда ключ не задан в localStorage. */
  defaultValue: boolean;
  /**
   * Категория для группировки в UI (analytics / experimental / debug).
   */
  category: "analytics" | "experimental" | "debug";
}

/**
 * Registry всех известных client-side флагов. Должны быть здесь чтобы
 * admin UI знал что показать. Произвольные ключи можно тоже set'ать через
 * DevTools — но они не появятся в UI.
 */
export const CLIENT_FEATURE_FLAGS: readonly ClientFeatureFlag[] = [
  {
    key: "capflow.feature.lendingAudit",
    label: "Lending on-chain audit (auto-fix)",
    description:
      "Для Aave V3 / Spark / Compound V3 lending позиций — читать on-chain Mint/Burn events aToken'а через Etherscan и переопределять `depositAmountSum` в `computeFees`, чтобы supply yield считался от authoritative on-chain сумм, а не от (возможно неполной) DeBank history. Лечит POS-008 WBTC ghost yield $5 282 → $69. ⚠ Может изменить цифры на $K-$M; рекомендуется только после manual verification.",
    defaultValue: false,
    category: "analytics",
  },
  {
    key: "capflow.feature.krystalV3CrossValidation",
    label: "Krystal V3 — cross-validation logs (dev)",
    description:
      "Fetch Krystal Cloud /v1/positions для каждого V3 LP wallet'а и сравнить с нашим OpenPosition (currentUsd / feesUsd / feesClaimedUsd). Diff > 5% → `console.warn` с разбивкой. Помогает увидеть где наши overrides врут. ⚠ Стоит 10 Krystal credits / wallet / fetch — следи за квотой.",
    defaultValue: false,
    category: "debug",
  },
  {
    key: "capflow.feature.krystalV3Primary",
    label: "Krystal V3 — primary source (override current state)",
    description:
      "Krystal становится authoritative для V3 LP current state: supplyTokens.amount/currentUsd, currentUsd, feesUsd/byToken, feesClaimedUsd/byToken, feesLifetimeUsd, PnL. Cost-basis side (startUsd, openedAt) остаётся UCB authoritative. Лечит POS-007 claimed $778 → $32.80, POS-006 $261 → $108 (баг #1 collect-vs-decrease). ⚠ Стоит Krystal credits, требует backend env KRYSTAL_API_KEY.",
    defaultValue: false,
    category: "experimental",
  },
];

function readFlagLocalStorage(key: string, defaultValue: boolean): boolean {
  if (typeof window === "undefined") return defaultValue;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return defaultValue;
    return raw === "true" || raw === "1";
  } catch {
    return defaultValue;
  }
}

/**
 * Получить значение client-side флага. Pure function — caller'ы могут
 * вызывать на любом уровне (не нужен hook).
 */
export function getClientFlag(key: string, defaultValue: boolean): boolean {
  return readFlagLocalStorage(key, defaultValue);
}

/**
 * Установить значение client-side флага. После set требуется
 * `location.reload()` чтобы изменения подхватились в memoized React
 * computations (большинство флагов читаются один раз при render'е).
 */
export function setClientFlag(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, value ? "true" : "false");
  } catch {
    /* quota */
  }
}

/** Сбросить флаг к default'у (удалить ключ из localStorage). */
export function resetClientFlag(key: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

// ──────────────── Convenience accessors для известных флагов ────────────────

/**
 * UCB on-chain audit для lending позиций (Aave V3 / Spark / Compound V3).
 *
 * Когда включён — `useLendingAudit` hook применяет on-chain
 * authoritative `netDeposited` для override'а `depositAmountSum` в
 * `computeFees`. Это исправляет ghost yield от пропущенных DeBank
 * supply tx (POS-008 WBTC $5 282 → $69).
 *
 * **Default: OFF** — фикс меняет цифры на $K-$M, нужна manual verification.
 */
export function isLendingAuditEnabled(): boolean {
  return getClientFlag("capflow.feature.lendingAudit", false);
}

/**
 * Krystal V3 cross-validation: при включении `useKrystalV3Positions` hook
 * fetch'ит Krystal Cloud /v1/positions для каждого wallet'а и сравнивает
 * с нашим OpenPosition (currentUsd / feesUsd / feesClaimedUsd). Diff > 5%
 * → `console.warn` с разбивкой. Помогает увидеть где наши overrides врут
 * (POS-007 claimed: наши $758 vs Krystal $32.90 = реальный Collect events).
 *
 * **Default: OFF** — Krystal стоит credits (10/call/wallet). Включаем для
 * dev/staging cross-validation.
 *
 * Future: при `capflow.feature.krystalV3PrimaryEnabled = true` (отдельный
 * flag, не существует пока) Krystal становится PRIMARY source для V3
 * current state (вытесняет on-chain feeGrowth math + DeBank).
 */
export function isKrystalV3CrossValidationEnabled(): boolean {
  return getClientFlag("capflow.feature.krystalV3CrossValidation", false);
}

/**
 * PR-K3: Krystal V3 как PRIMARY source для current state V3 LP позиций.
 *
 * При ON — после всех существующих override'ов (`applyV3CostBasisOverride`,
 * Phase J, lending, CEX inheritance) запускается `applyKrystalV3Override`,
 * который переписывает current-state поля (supplyTokens.amount/currentUsd,
 * currentUsd, feesUsd/byToken, feesClaimedUsd/byToken, feesLifetimeUsd, PnL,
 * feeApr). Cost-basis side (startUsd, openedAt, ageDays, etc.) НЕ трогается
 * — UCB lots остаются authoritative для cross-protocol attribution.
 *
 * Это фиксит:
 *  - POS-007 claimed inflated $778 → $32.80 (real Collect events)
 *  - POS-006 claimed inflated $261 → $108
 *  - Все pending fees через Krystal server-side feeGrowth (matches Uniswap UI
 *    точно, без нашего multicall complexity)
 *
 * **Default: OFF** — экономим Krystal credits (10/wallet/call). Включаем
 * через localStorage когда committed к Krystal-first архитектуре.
 *
 * Требует:
 *   1. `capflow.feature.krystalV3CrossValidation = true` (Krystal hook fetches)
 *   2. `KRYSTAL_API_KEY` env на сервере (upstream-proxy)
 *   3. Положительный баланс credits на Krystal account
 */
export function isKrystalV3PrimaryEnabled(): boolean {
  return getClientFlag("capflow.feature.krystalV3Primary", false);
}
