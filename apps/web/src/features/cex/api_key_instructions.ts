/**
 * Инструкции по созданию API-ключей для каждой поддерживаемой биржи.
 *
 * Используется в onboarding wizard и в `CexExchangesPanel` (раскрывающаяся
 * подсказка рядом с полем ввода API key). Цель — чтобы новый пользователь
 * за 2-3 минуты создал read-only API key без походов в Google.
 *
 * Все инструкции исходят из требования **read-only** доступа:
 *  - Никаких permissions на trading / withdraw / transfer
 *  - Permissions достаточно: Read account balances, Read trade history,
 *    Read deposit/withdraw history
 *  - IP whitelist опциональный — рекомендуется но НЕ обязательный
 *
 * Если биржа добавила MFA/IP/whitelist обязательным — обновить здесь.
 */

import type { ExchangeId } from "./api";

export interface CexApiKeyInstructions {
  exchangeId: ExchangeId;
  /** Отображаемое имя биржи. */
  displayName: string;
  /** Прямая ссылка на страницу управления API keys. */
  apiKeyPageUrl: string;
  /** Требуется ли passphrase в дополнение к key+secret. */
  requiresPassphrase: boolean;
  /** Какие permissions нужно отметить (read-only). */
  requiredPermissions: readonly string[];
  /** Какие permissions НЕ отмечать (security). */
  forbiddenPermissions: readonly string[];
  /** Пошаговая инструкция. */
  steps: readonly string[];
  /** Notes / частые проблемы и их решения. */
  notes: readonly string[];
  /** Окно retention сделок (для предупреждения о limits). */
  tradeHistoryLimitDays: number;
}

export const CEX_API_KEY_INSTRUCTIONS: Record<ExchangeId, CexApiKeyInstructions> = {
  bybit: {
    exchangeId: "bybit",
    displayName: "Bybit",
    apiKeyPageUrl: "https://www.bybit.com/app/user/api-management",
    requiresPassphrase: false,
    requiredPermissions: [
      "Account → Wallet (Read)",
      "Trade → Spot Trade (Read)",
      "Trade → Derivatives (Read) — опционально, если торгуете USDT-perp",
    ],
    forbiddenPermissions: [
      "Trade → Withdraw",
      "Trade → Internal Transfer",
      "Trade → SubAccount Transfer",
    ],
    steps: [
      "Войдите в Bybit → правый верхний угол → «API Management»",
      "Нажмите «Create New Key» → выберите «System-generated API Keys»",
      "Тип ключа: «API Transaction»",
      "Имя ключа: например «Capflow read-only»",
      "В permissions отметьте ТОЛЬКО Read для Wallet и Spot Trade",
      "IP restriction: оставьте «Unrestricted» (или укажите IP сервера если знаете)",
      "Время жизни: 90 дней (Bybit лимит) — обновите перед истечением",
      "Сохраните API Key + Secret в надёжное место — Secret показывается ОДИН РАЗ",
    ],
    notes: [
      "Bybit Trade History доступен **только за последние 2 года**. Старые сделки нужно импортировать CSV вручную.",
      "При истечении ключа (через 90 дней) Capflow покажет 401 — просто создайте новый и обновите.",
    ],
    tradeHistoryLimitDays: 720,
  },

  okx: {
    exchangeId: "okx",
    displayName: "OKX",
    apiKeyPageUrl: "https://www.okx.com/account/my-api",
    requiresPassphrase: true,
    requiredPermissions: ["Read"],
    forbiddenPermissions: ["Trade", "Withdraw"],
    steps: [
      "Войдите в OKX → правый верхний угол → «Profile» → «API»",
      "Нажмите «Create V5 API Key»",
      "Имя ключа: «Capflow read-only»",
      "**Passphrase** — это ВАШ кастомный пароль для API (НЕ пароль аккаунта). Запомните его — потребуется в Capflow.",
      "Permissions: отметьте ТОЛЬКО «Read» (НЕ Trade, НЕ Withdraw)",
      "IP whitelist: оставьте пустым для удобства (но можно добавить ваш IP)",
      "Подтвердите через email + Google Authenticator",
      "Сохраните API Key + Secret + Passphrase",
    ],
    notes: [
      "OKX даёт **самый длинный history** — до 7 лет через bills-archive.",
      "ВНИМАНИЕ: Passphrase в OKX — это **отдельная** строка, НЕ пароль аккаунта.",
      "Если ключ перестал работать — проверьте Permissions в OKX (иногда сбрасываются на defaults).",
    ],
    tradeHistoryLimitDays: 2555,
  },

  bitget: {
    exchangeId: "bitget",
    displayName: "Bitget",
    apiKeyPageUrl: "https://www.bitget.com/account/newapi",
    requiresPassphrase: true,
    requiredPermissions: ["Read-only"],
    forbiddenPermissions: ["Trade", "Withdraw", "Transfer"],
    steps: [
      "Войдите в Bitget → Avatar → «API Management»",
      "Нажмите «Create API»",
      "Имя ключа: «Capflow read-only»",
      "**Passphrase** — придумайте свой (НЕ пароль аккаунта). Запомните.",
      "Permissions: отметьте только «Read-only»",
      "IP binding: можно оставить пустым",
      "Verification: email + 2FA (Google Authenticator)",
      "Сохраните API Key + Secret + Passphrase",
    ],
    notes: [
      "Bitget P2P sync доступен через отдельный tax-endpoint (Capflow подтянет автоматически).",
      "Иногда Bitget блокирует регион (по IP) — если 403, поможет VPN на момент создания ключа.",
    ],
    tradeHistoryLimitDays: 90,
  },

  mexc: {
    exchangeId: "mexc",
    displayName: "MEXC",
    apiKeyPageUrl: "https://www.mexc.com/user/openapi",
    requiresPassphrase: false,
    requiredPermissions: ["Read Information"],
    forbiddenPermissions: ["Spot Trade", "Withdraw", "Universal Transfer"],
    steps: [
      "Войдите в MEXC → Profile → «API Management»",
      "Нажмите «Create New API»",
      "Имя: «Capflow read-only»",
      "Permissions: ТОЛЬКО «Read Information» (НЕ Spot, НЕ Withdraw)",
      "IP whitelist: оставьте пустым",
      "Подтверждение: email + 2FA",
      "Сохраните API Key + Secret",
    ],
    notes: [
      "MEXC retention для trades — **только 3 месяца**. Для полного history — импорт CSV/XLSX.",
      "MEXC иногда требует KYC для активации API key. Если key есть но не работает — проверьте KYC статус.",
    ],
    tradeHistoryLimitDays: 90,
  },

  bingx: {
    exchangeId: "bingx",
    displayName: "BingX",
    apiKeyPageUrl: "https://bingx.com/en-us/account/api",
    requiresPassphrase: false,
    requiredPermissions: ["Read"],
    forbiddenPermissions: ["Trade", "Universal Transfer", "Withdraw"],
    steps: [
      "Войдите в BingX → Profile (правый верхний) → «API Management»",
      "Нажмите «Create API»",
      "Имя: «Capflow read-only»",
      "Permissions: только «Read»",
      "IP restriction: «Unrestricted access» (или укажите IP)",
      "2FA verification",
      "Сохраните API Key + Secret",
    ],
    notes: [
      "BingX retention для trades — **6 месяцев** (180 дней).",
      "BingX иногда временно блокирует ключи при подозрительной активности — пересоздайте если 401.",
    ],
    tradeHistoryLimitDays: 180,
  },

  binance: {
    exchangeId: "binance",
    displayName: "Binance",
    apiKeyPageUrl: "https://www.binance.com/en/my/settings/api-management",
    requiresPassphrase: false,
    requiredPermissions: [
      "Enable Reading",
    ],
    forbiddenPermissions: [
      "Enable Spot & Margin Trading",
      "Enable Futures",
      "Enable Withdrawals",
      "Permits Universal Transfer",
    ],
    steps: [
      "Войдите в Binance → правый верхний угол → «Account» → «API Management»",
      "Нажмите «Create API» → выберите «System generated»",
      "Имя ключа: например «Capflow read-only»",
      "Пройдите 2FA / email verification",
      "В permissions оставьте ТОЛЬКО «Enable Reading». Снимите Spot Trading, Futures, Withdrawals и Universal Transfer.",
      "IP restriction: можно оставить «Unrestricted» (или указать IP сервера если знаете)",
      "Сохраните API Key и Secret — Secret показывается ОДИН РАЗ",
    ],
    notes: [
      "Binance держит spot trade history бессрочно, но требует фильтр по symbol — Capflow итерирует по активам из вашего баланса.",
      "Endpoint `/api/v3/myTrades` принимает диапазон не больше 24 часов за один запрос — поэтому глубокий бэкфилл идёт долго. Если нужна история глубже ~6 мес — выгрузите CSV из Binance и импортируйте.",
      "Если ключ из РФ — может потребоваться VPN для probe (Binance геоблокирует часть IP-диапазонов).",
    ],
    tradeHistoryLimitDays: 200,
  },
};

/**
 * Convenience: получить инструкцию по ID.
 */
export function getCexApiKeyInstructions(
  id: ExchangeId,
): CexApiKeyInstructions {
  return CEX_API_KEY_INSTRUCTIONS[id];
}

/**
 * Список всех бирж с базовой инфой для отображения в picker'е.
 */
export interface ExchangeListItem {
  id: ExchangeId;
  displayName: string;
  requiresPassphrase: boolean;
  /** Краткое преимущество для UI ("Best history depth", "Fast onboarding"). */
  tagline: string;
}

export const ALL_EXCHANGES_LIST: readonly ExchangeListItem[] = [
  {
    id: "bybit",
    displayName: "Bybit",
    requiresPassphrase: false,
    tagline: "2 года истории · быстрая активация",
  },
  {
    id: "okx",
    displayName: "OKX",
    requiresPassphrase: true,
    tagline: "До 7 лет истории — лучший выбор для старых аккаунтов",
  },
  {
    id: "bitget",
    displayName: "Bitget",
    requiresPassphrase: true,
    tagline: "90 дней · P2P sync",
  },
  {
    id: "mexc",
    displayName: "MEXC",
    requiresPassphrase: false,
    tagline: "3 месяца · доимпорт CSV",
  },
  {
    id: "bingx",
    displayName: "BingX",
    requiresPassphrase: false,
    tagline: "6 месяцев истории",
  },
  {
    id: "binance",
    displayName: "Binance",
    requiresPassphrase: false,
    tagline: "Бессрочная история · per-symbol sync",
  },
];
