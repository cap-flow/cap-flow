/**
 * Shared types for the CEX integration. Kept exchange-agnostic so the
 * routes/repos/services don't import CCXT directly — only the
 * `CexClient` adapter does.
 */

/**
 * Whitelist of exchanges we currently support. Keeping it explicit
 * prevents an attacker from injecting `ccxt.evilExchange` via a body
 * param. New entries land here AND in the per-exchange config of
 * `createCexClient`.
 */
export const SUPPORTED_EXCHANGES = [
  "bybit",
  "okx",
  "bitget",
  "mexc",
  "bingx",
] as const;

export type ExchangeId = (typeof SUPPORTED_EXCHANGES)[number];

export function isSupportedExchange(s: string): s is ExchangeId {
  return (SUPPORTED_EXCHANGES as readonly string[]).includes(s);
}

/**
 * Credentials a user provides at connect-time. Passphrase is required
 * for OKX and Bitget — these exchanges issue (apiKey + secret + passphrase)
 * triples. Bybit and MEXC use the legacy (apiKey + secret) pair.
 */
export interface CexCredentials {
  readonly apiKey: string;
  readonly apiSecret: string;
  /** Required for OKX and Bitget. Ignored by Bybit / MEXC. */
  readonly apiPassphrase?: string;
}

/**
 * Snapshot of what an API key can do. Probed at connect-time so we
 * reject keys with trade/withdraw permissions (Capflow is read-only).
 *
 *   read     — can fetch balance / trades / deposits-withdrawals
 *   trade    — can place/cancel orders   → MUST be false
 *   withdraw — can move funds off-exchange → MUST be false
 *   unknown  — true when the exchange doesn't expose permissions cleanly;
 *              we still let the user connect but flag a warning
 *
 * **B1 (UCB data integrity):** добавлены 3 поля для реального probe'а
 * read-доступа к историческим эндпоинтам. Старые `trade`/`withdraw`
 * остаются «MUST be false» для безопасности (Capflow не торгует), а
 * `tradeHistory`/`deposits`/`withdrawals` отвечают именно на вопрос
 * «может ли наш sync читать эту историю?». Без этого разделения
 * `trade: false` путал две разные вещи (нет права торговать vs нет
 * права читать историю сделок).
 */
export interface CexPermissions {
  readonly read: boolean;
  readonly trade: boolean;
  readonly withdraw: boolean;
  readonly unknown: boolean;
  /** Может ли API-key читать историю сделок (`fetchMyTrades`). */
  readonly tradeHistory?: PermStatus;
  /** Может ли читать историю депозитов (`fetchDeposits`). */
  readonly deposits?: PermStatus;
  /** Может ли читать историю выводов (`fetchWithdrawals`). */
  readonly withdrawals?: PermStatus;
  /** ISO timestamp последнего probe — для UI «когда последний раз проверяли». */
  readonly lastProbedAt?: string;
}

/**
 * Состояние permission'а для data-read эндпоинта.
 *
 *   ok          — endpoint работает (даже если empty response)
 *   denied      — explicit 401/403/«permission»/«unauthorized»
 *   unsupported — CCXT не имеет такого method'а для этой биржи
 *   unknown     — probe не запускался, transient error (network/timeout)
 *
 * Зачем enum вместо boolean: B4 «Sync coverage report UI» должен
 * различать «не пробовали» vs «биржа явно запретила». Boolean смешивает
 * эти случаи и UI не может дать точный совет пользователю.
 */
export type PermStatus = "ok" | "denied" | "unsupported" | "unknown";

/**
 * Unified balance line. CCXT's `fetchBalance()` returns nested per-asset
 * objects; we flatten to per-(asset × accountType) for ledger insertion.
 */
export interface CexBalanceLine {
  readonly asset: string;
  readonly accountType: "spot" | "margin" | "futures" | "earn" | "funding";
  readonly free: number;
  readonly used: number;
  readonly total: number;
}

/**
 * Unified trade. Mirrors CCXT's normalized trade shape but with `cost`
 * always present (CCXT marks it optional even though it's almost always
 * `price × amount`).
 */
export interface CexTradeLine {
  readonly id: string;
  readonly symbol: string;
  readonly side: "buy" | "sell";
  readonly amount: number;
  readonly price: number;
  readonly cost: number;
  readonly fee?: {
    readonly currency: string;
    readonly cost: number;
  };
  readonly takerOrMaker?: "taker" | "maker";
  readonly executedAtMs: number;
}
