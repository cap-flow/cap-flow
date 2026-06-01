import type { Env } from "../../config/env.js";

/**
 * Каталог admin-настраиваемых «кнобов» приложения.
 *
 * Единый источник правды для: (1) admin-UI (что показать/как валидировать),
 * (2) рантайм-резолвера (`AppSettingsService` — дефолты и тип). Дефолты тянутся
 * из валидированного `Env`, поэтому zod-дефолты env остаются единственным
 * местом дефолтов; DB-override лишь перекрывает их при наличии.
 *
 * scope:
 *   - "backend"  — значение читается на сервере (rate limits, квоты, cache TTL).
 *   - "frontend" — значение отдаётся клиенту через GET /v1/me/app-config
 *                  (DeBank history maxPages, интервал авто-рефреша).
 * hotReload:
 *   - "live"     — рантайм перечитывает значение (через сервис) без рестарта.
 *   - "restart"  — читается в конструкторе клиента/сервиса; override применится
 *                  на следующем старте API (UI показывает хинт).
 */
export type SettingValueType = "number" | "boolean" | "string";
export type SettingScope = "backend" | "frontend";
export type SettingHotReload = "live" | "restart";

export interface SettingDefinition {
  readonly key: string;
  readonly scope: SettingScope;
  readonly group: string;
  readonly label: string;
  readonly description: string;
  readonly valueType: SettingValueType;
  readonly defaultValue: number | boolean | string;
  readonly min?: number;
  readonly max?: number;
  readonly hotReload: SettingHotReload;
}

/**
 * Строит каталог с дефолтами из env. Вызывается один раз при конструировании
 * `AppSettingsService`.
 */
export function buildSettingsCatalog(env: Env): SettingDefinition[] {
  return [
    /* ----------------------------- Rate limits ---------------------------- */
    {
      key: "upstream.ratePerMin",
      scope: "backend",
      group: "Rate limits",
      label: "Upstream-прокси: запросов в минуту (на юзера)",
      description:
        "Лимит запросов к внешним API через upstream-прокси на одного пользователя в минуту. 60 = обычная сессия, 600 = power-user, 6000 = фактически выкл.",
      valueType: "number",
      defaultValue: env.UPSTREAM_RATE_PER_MIN,
      min: 1,
      max: 100000,
      hotReload: "live",
    },
    {
      key: "upstream.ratePerHour",
      scope: "backend",
      group: "Rate limits",
      label: "Upstream-прокси: запросов в час (на юзера)",
      description:
        "Часовой лимит. Должен быть ≥ 10× минутного, чтобы легитимный всплеск не блокировал юзера надолго.",
      valueType: "number",
      defaultValue: env.UPSTREAM_RATE_PER_HOUR,
      min: 1,
      max: 1000000,
      hotReload: "live",
    },

    /* ------------------------------- Quotas ------------------------------- */
    {
      key: "quota.debankPerDay",
      scope: "backend",
      group: "Квоты (в день, на юзера)",
      label: "DeBank: запросов в день",
      description: "Суточная квота DeBank на пользователя.",
      valueType: "number",
      defaultValue: env.QUOTA_DEBANK_PER_DAY,
      min: 1,
      max: 10000000,
      hotReload: "live",
    },
    {
      key: "quota.alchemyPerDay",
      scope: "backend",
      group: "Квоты (в день, на юзера)",
      label: "Alchemy: запросов в день",
      description: "Суточная квота Alchemy на пользователя.",
      valueType: "number",
      defaultValue: env.QUOTA_ALCHEMY_PER_DAY,
      min: 1,
      max: 10000000,
      hotReload: "live",
    },
    {
      key: "quota.etherscanPerDay",
      scope: "backend",
      group: "Квоты (в день, на юзера)",
      label: "Etherscan: запросов в день",
      description: "Суточная квота Etherscan на пользователя.",
      valueType: "number",
      defaultValue: env.QUOTA_ETHERSCAN_PER_DAY,
      min: 1,
      max: 10000000,
      hotReload: "live",
    },
    {
      key: "quota.coingeckoPerDay",
      scope: "backend",
      group: "Квоты (в день, на юзера)",
      label: "CoinGecko: запросов в день",
      description: "Суточная квота CoinGecko на пользователя.",
      valueType: "number",
      defaultValue: env.QUOTA_COINGECKO_PER_DAY,
      min: 1,
      max: 10000000,
      hotReload: "live",
    },

    /* ------------------------------ Cache TTL ----------------------------- */
    {
      key: "cache.priceTtlSec",
      scope: "backend",
      group: "Cache TTL",
      label: "TTL кэша цен (сек)",
      description:
        "Сколько секунд кэшируются котировки. Читается при старте — применяется после рестарта API.",
      valueType: "number",
      defaultValue: env.CACHE_PRICE_TTL_SEC,
      min: 1,
      max: 86400,
      hotReload: "restart",
    },
    {
      key: "cache.balanceTtlSec",
      scope: "backend",
      group: "Cache TTL",
      label: "TTL кэша балансов (сек)",
      description:
        "Сколько секунд кэшируются балансы. Читается при старте — применяется после рестарта API.",
      valueType: "number",
      defaultValue: env.CACHE_BALANCE_TTL_SEC,
      min: 1,
      max: 86400,
      hotReload: "restart",
    },

    /* ------------------------------- Retry -------------------------------- */
    {
      key: "upstream.retryMaxRetries",
      scope: "backend",
      group: "Retry/backoff",
      label: "Макс. ретраев upstream",
      description:
        "Сколько раз ретраить 429/502/503/504. Читается при старте — нужен рестарт.",
      valueType: "number",
      defaultValue: 3,
      min: 0,
      max: 10,
      hotReload: "restart",
    },
    {
      key: "upstream.retryBaseBackoffMs",
      scope: "backend",
      group: "Retry/backoff",
      label: "Базовый backoff (мс)",
      description: "Базовая задержка экспоненциального backoff. Нужен рестарт.",
      valueType: "number",
      defaultValue: 250,
      min: 10,
      max: 60000,
      hotReload: "restart",
    },
    {
      key: "upstream.retryMaxBackoffMs",
      scope: "backend",
      group: "Retry/backoff",
      label: "Макс. backoff (мс)",
      description: "Потолок задержки backoff. Нужен рестарт.",
      valueType: "number",
      defaultValue: 4000,
      min: 100,
      max: 120000,
      hotReload: "restart",
    },

    /* ------------------------- DeBank история (frontend) ------------------ */
    {
      key: "debank.historyMaxPagesFirstLoad",
      scope: "frontend",
      group: "DeBank история",
      label: "Макс. страниц при первой загрузке",
      description:
        "Сколько страниц истории (×20 операций) тянуть при ПЕРВОМ бэкфилле кошелька. Большое значение = полная история, но дороже по кредитам.",
      valueType: "number",
      defaultValue: 500,
      min: 1,
      max: 5000,
      hotReload: "live",
    },
    {
      key: "debank.historyMaxPagesIncremental",
      scope: "frontend",
      group: "DeBank история",
      label: "Макс. страниц при инкременте",
      description:
        "Сколько страниц тянуть при последующих загрузках (когда история уже полна). stopWhen всё равно стопит на известной tx; это предохранитель.",
      valueType: "number",
      defaultValue: 5,
      min: 1,
      max: 100,
      hotReload: "live",
    },

    /* ------------------------- Авто-рефреш (frontend) --------------------- */
    {
      key: "frontend.autoRefreshMinIntervalMs",
      scope: "frontend",
      group: "Авто-рефреш",
      label: "Мин. интервал авто-рефреша (мс)",
      description:
        "Не обновлять кошельки чаще, чем раз в столько мс, и только когда вкладка активна и online. По умолчанию 1 час (3600000).",
      valueType: "number",
      defaultValue: 60 * 60 * 1000,
      min: 60_000,
      max: 24 * 60 * 60 * 1000,
      hotReload: "live",
    },
  ];
}
