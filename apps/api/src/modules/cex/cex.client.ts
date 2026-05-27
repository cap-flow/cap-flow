import ccxt, { type Exchange } from "ccxt";

import type { CexProxyConfig } from "./cex.proxy.js";
import type {
  CexBalanceLine,
  CexCredentials,
  CexPermissions,
  CexTradeLine,
  ExchangeId,
  PermStatus,
} from "./cex.types.js";

/**
 * Per-exchange configuration. Centralized so adding a new exchange is
 * one entry rather than several scattered branches.
 *
 *   - `requiresPassphrase` — OKX / Bitget issue (key, secret, passphrase)
 *     triples; without the third part their HMAC fails.
 */
/**
 * Per-exchange configuration.
 *
 *   - `requiresPassphrase`     — OKX / Bitget need a third HMAC param.
 *   - `ccxtOptions`            — passed verbatim to `new ccxt[id]({...})`.
 *                                Used to avoid slow / blocked endpoints
 *                                during market loading.
 *
 * NB: Bitget's default `loadMarkets()` fetches spot+swap+future+margin
 * markets. The `/api/v2/margin/currencies` endpoint is consistently
 * slow (and often geo-blocked from RU/CIS IPs), causing 30s timeouts
 * even when the user only needs spot. We pin `fetchMarkets` to spot
 * and run with a more generous 60s timeout.
 */
const EXCHANGE_CONFIG: Record<
  ExchangeId,
  {
    requiresPassphrase: boolean;
    ccxtOptions?: Record<string, unknown>;
  }
> = {
  // Bybit V5 enforces strict timestamp validation: requests are rejected
  // with `retCode 10002 "invalid request, please check your server
  // timestamp or recv_window param"` when client clock drifts even a few
  // seconds from Bybit's server. We bump recv_window to 60s (default 5s)
  // so transient NTP jitter / long-running batch calls don't trip the
  // signature check during `fetchLedger` / `fetchClosedOrders` chunked
  // pagination. CCXT reads `options.recvWindow` and forwards it.
  bybit: {
    requiresPassphrase: false,
    ccxtOptions: {
      recvWindow: 60_000,
    },
  },
  okx: { requiresPassphrase: true },
  bitget: {
    requiresPassphrase: true,
    ccxtOptions: {
      defaultType: "spot",
      fetchMarkets: ["spot"],
    },
  },
  mexc: { requiresPassphrase: false },
  // BingX uses (apiKey, secret) — no passphrase. Read-only key is
  // created in BingX → Account → API Management with "Read" scope.
  // Same trick as Bitget: pin market loading to spot only — BingX's
  // /openApi/spot/v1/common/symbols by itself can take 30-60s, and
  // CCXT additionally tries swap markets which compounds the delay.
  bingx: {
    requiresPassphrase: false,
    ccxtOptions: {
      defaultType: "spot",
      fetchMarkets: ["spot"],
    },
  },
  // Binance uses (apiKey, secret) — no passphrase. Read-only key из
  // Binance → API Management с включёнными «Enable Reading» + (для
  // /sapi/* endpoints — обязательно: «Permits Universal Transfer» НЕ
  // включать, нужен только Read). Pin defaultType+fetchMarkets к spot,
  // т.к. полный loadMarkets у Binance тянет ~25Mb (spot+margin+futures
  // +options) — это легко 60s timeout.
  binance: {
    requiresPassphrase: false,
    ccxtOptions: {
      defaultType: "spot",
      fetchMarkets: ["spot"],
    },
  },
};

/**
 * Cleaner type for the CCXT client we expose — adds `probePermissions`
 * convenience. `probeError` is the last underlying error surfaced by
 * fetchBalance during the probe (if any) — kept around so callers can
 * report it instead of a generic "permission denied".
 */
export type CexClient = Exchange & {
  probePermissions(): Promise<CexPermissions>;
  probeError?: string | null;
};

/**
 * Build a CCXT exchange instance with our defaults:
 *   - Enable built-in rate-limit (CCXT throttles to advertised per-
 *     exchange limits; without this we can easily get banned)
 *   - Mandate passphrase for exchanges that need one
 *   - Attach `probePermissions` for the connect-time safety audit
 *   - Route through `proxy.agent` when set so RU/CIS-deployed APIs
 *     can still reach Bybit/OKX/BingX (their CDN geoblocks us
 *     otherwise — see [cex.proxy.ts](./cex.proxy.ts)).
 */
export function createCexClient(
  exchangeId: ExchangeId,
  creds: CexCredentials,
  proxy: CexProxyConfig | null = null
): CexClient {
  const cfg = EXCHANGE_CONFIG[exchangeId];
  if (cfg.requiresPassphrase && !creds.apiPassphrase) {
    throw new Error(
      `Exchange '${exchangeId}' requires an API passphrase. ` +
        `Re-create the API key on the exchange and copy the passphrase shown ONCE at create-time.`
    );
  }
  const ctor = (ccxt as unknown as Record<string, new (cfg: unknown) => Exchange>)[
    exchangeId
  ];
  if (!ctor) {
    throw new Error(`CCXT has no exchange named '${exchangeId}'`);
  }
  const c = new ctor({
    apiKey: creds.apiKey,
    secret: creds.apiSecret,
    ...(creds.apiPassphrase ? { password: creds.apiPassphrase } : {}),
    enableRateLimit: true,
    // 60s per request. CCXT default is 10s, which is too tight for
    // some exchanges (Bitget's market-loading endpoints can take
    // 20-40s from non-Asian IPs).
    timeout: 60_000,
    ...(cfg.ccxtOptions ? { options: cfg.ccxtOptions } : {}),
  }) as CexClient;
  // Route through proxy when configured. CCXT picks up the agent for
  // both HTTP and HTTPS requests through node-fetch.
  if (proxy) {
    (c as unknown as { agent?: unknown }).agent = proxy.agent;
  }

  // Attach the audit method. Behavioral probe в 4 шага:
  //   1. fetchBalance → confirm `read`. Если падает → ключ невалидный,
  //      все остальные probe'ы тоже unknown (нет смысла продолжать).
  //   2. fetchMyTrades(testSymbol) → `tradeHistory` status.
  //   3. fetchDeposits(testAsset)  → `deposits` status.
  //   4. fetchWithdrawals(testAsset) → `withdrawals` status.
  //
  // Каждый шаг 2-4 защищён `client.has[methodName]` — если CCXT не
  // имеет endpoint для этой биржи → `unsupported`. Это правдивее чем
  // прежнее «всегда false с unknown=true», и B4 (sync coverage UI)
  // сможет точно отличить «не пробовали» от «запрещено».
  c.probePermissions = async () => {
    const lastProbedAt = new Date().toISOString();
    let readOk = false;
    try {
      await c.fetchBalance();
      c.probeError = null;
      readOk = true;
    } catch (e) {
      c.probeError = (e as Error).message?.slice(0, 500) ?? "unknown error";
    }
    if (!readOk) {
      // Без read — нет смысла дёргать остальные endpoints. Помечаем их
      // unknown (transient/unprobed), не denied (мы не знаем).
      return {
        read: false,
        trade: false,
        withdraw: false,
        unknown: false,
        tradeHistory: "unknown" as PermStatus,
        deposits: "unknown" as PermStatus,
        withdrawals: "unknown" as PermStatus,
        lastProbedAt,
      };
    }
    const tradeHistory = await probeEndpoint(c, "fetchMyTrades", "BTC/USDT");
    const deposits = await probeEndpoint(c, "fetchDeposits", "BTC");
    const withdrawals = await probeEndpoint(c, "fetchWithdrawals", "BTC");
    return {
      read: true,
      // `trade` / `withdraw` — MUST-BE-FALSE markers (Capflow read-only).
      // Эти поля НЕ означают «можем читать историю» — для этого
      // tradeHistory/withdrawals выше.
      trade: false,
      withdraw: false,
      unknown: false,
      tradeHistory,
      deposits,
      withdrawals,
      lastProbedAt,
    };
  };

  return c;
}

/**
 * Низкоуровневая helper-функция: пробует CCXT-method и интерпретирует
 * результат как `PermStatus`.
 *
 *   - method отсутствует / `client.has[method] === false` → 'unsupported'
 *   - method вернул что угодно (даже [])                  → 'ok'
 *   - ошибка с маркерами permission                       → 'denied'
 *   - ошибка «requires symbol» (нужен аргумент)           → 'ok'
 *     (биржа умеет, просто без symbol не отдаёт; sync'ает per-symbol)
 *   - timeout / network / generic                         → 'unknown'
 */
async function probeEndpoint(
  client: Exchange,
  methodName: "fetchMyTrades" | "fetchDeposits" | "fetchWithdrawals",
  symbolOrAsset: string,
): Promise<PermStatus> {
  // Сначала смотрим что CCXT вообще умеет делать на этой бирже.
  // CCXT держит карту фич в `.has[methodName]`. Если false (или
  // 'emulated' в строковом виде → не настоящий API) — unsupported.
  const has = (client as { has?: Record<string, boolean | string> }).has;
  const supported = has?.[methodName];
  if (!supported || supported === "emulated") return "unsupported";
  // Sanity: метод вообще существует на инстансе?
  const fn = (client as unknown as Record<string, unknown>)[methodName];
  if (typeof fn !== "function") return "unsupported";

  try {
    // Минимальный probe-call. Symbol/asset нужен потому что часть бирж
    // (Bitget/BingX) требуют его. `limit:1` чтобы не тянуть лишнее, но
    // CCXT для некоторых endpoints его игнорирует — это ок, нас интересует
    // только success/permission-error.
    await (fn as (s: string, _?: unknown, __?: unknown, opts?: unknown) => Promise<unknown>)
      .call(client, symbolOrAsset, undefined, undefined, { limit: 1 });
    return "ok";
  } catch (e) {
    const msg = (e as Error).message ?? "";
    return classifyProbeError(msg);
  }
}

/**
 * Маппит сырой error-string из CCXT в `PermStatus`.
 *
 * Список регексов выведен из реальных сообщений:
 *   - Bybit:    "permission denied for the api key"
 *   - OKX:      "invalid sign / no permission"
 *   - Bitget:   "{ "code": "40016", "msg": "no permission" }"
 *   - BingX:    "100410 IP whitelist required" / "code 109400 permission"
 *   - Generic:  "401 Unauthorized", "403 Forbidden"
 *   - Network:  "request timed out", "fetch failed", "ECONNRESET"
 */
function classifyProbeError(msg: string): PermStatus {
  if (!msg) return "unknown";
  // «requires a symbol argument» — биржа отдаёт historic data только с
  // symbol-фильтром (Bitget, BingX, OKX), но сам endpoint работает.
  // Это ok: трактуем как `ok`, sync'ает per-symbol через fallback.
  if (/requires .*symbol/i.test(msg)) return "ok";
  // Explicit permission markers — биржа явно отказала.
  if (
    /\b401\b|\b403\b|unauthor[iz]+ed|permission|not allowed|forbidden|invalid (?:sign|signature|api[- ]?key)|whitelist|insufficient (?:permission|privilege)/i.test(
      msg,
    )
  ) {
    return "denied";
  }
  // Network / transient — не знаем что с permission.
  if (
    /timed out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|fetch failed|network/i.test(
      msg,
    )
  ) {
    return "unknown";
  }
  // Generic exchange error — без явного permission-marker'а. Скорее
  // всего проблема не в правах, а в чём-то ещё (rate limit, malformed
  // symbol). Помечаем unknown, не denied.
  return "unknown";
}

/**
 * Flatten CCXT's nested balance shape (one big object with mixed
 * meta-fields + per-asset entries) into ledger-friendly rows.
 *
 * CCXT shape: `{ BTC: {free, used, total}, USDT: {free, used, total},
 *               info: {...}, timestamp: ..., free: {...}, used: {...},
 *               total: {...} }`
 * Returns:    `[{asset: "BTC", accountType: "spot", free, used, total}, ...]`
 */
export function normalizeBalance(
  ccxtBalance: unknown,
  accountType: CexBalanceLine["accountType"]
): CexBalanceLine[] {
  if (!ccxtBalance || typeof ccxtBalance !== "object") return [];
  const out: CexBalanceLine[] = [];
  // Meta-fields that CCXT mixes into the balance object — must not be
  // treated as assets.
  const skip = new Set([
    "info",
    "timestamp",
    "datetime",
    "free",
    "used",
    "total",
    "debt",
  ]);
  for (const [key, value] of Object.entries(
    ccxtBalance as Record<string, unknown>
  )) {
    if (skip.has(key)) continue;
    if (!value || typeof value !== "object") continue;
    const v = value as { free?: number; used?: number; total?: number };
    const total = Number(v.total ?? 0);
    if (!Number.isFinite(total) || total <= 0) continue;
    out.push({
      asset: key,
      accountType,
      free: Number(v.free ?? 0),
      used: Number(v.used ?? 0),
      total,
    });
  }
  return out;
}

/**
 * Normalize a CCXT trade. CCXT's `cost` is optional even though it's
 * always `price × amount` — we synthesize it when absent. Returns null
 * for malformed entries (missing id, zero amount, etc.) so the caller
 * can skip cleanly.
 */
export function normalizeTrade(t: {
  id?: string;
  symbol?: string;
  side?: "buy" | "sell";
  amount?: number;
  price?: number;
  cost?: number;
  fee?: { currency?: string; cost?: number };
  takerOrMaker?: "taker" | "maker";
  timestamp?: number;
}): CexTradeLine | null {
  if (!t.id || !t.symbol || !t.side || !t.timestamp) return null;
  const amount = Number(t.amount ?? 0);
  const price = Number(t.price ?? 0);
  if (amount <= 0 || price <= 0) return null;
  const cost = Number(t.cost ?? amount * price);
  return {
    id: t.id,
    symbol: t.symbol,
    side: t.side,
    amount,
    price,
    cost,
    ...(t.fee && t.fee.currency && t.fee.cost != null
      ? { fee: { currency: t.fee.currency, cost: Number(t.fee.cost) } }
      : {}),
    ...(t.takerOrMaker ? { takerOrMaker: t.takerOrMaker } : {}),
    executedAtMs: t.timestamp,
  };
}
