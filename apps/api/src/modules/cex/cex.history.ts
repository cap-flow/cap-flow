/**
 * Chunked historical sync для CEX endpoints с window-limit'ом.
 *
 * **Проблема:** Bybit / BingX / MEXC по умолчанию отдают только
 * последние **7 дней** trade-history (Bybit `/v5/execution/list` имеет
 * `startTime/endTime` с **maxRange = 7 days**). На первом sync user'а с
 * историей >7 дней мы получаем 0 trades — и POS-007 WBTC остаётся без
 * cost basis потому что покупка была >7 мес назад.
 *
 * **Решение:** loop по time-window'ам `[since, since+W]`, `[since+W,
 * since+2W]` … до `now`. Это classic backfill-pattern.
 *
 * Per-exchange window:
 *   - bybit:  7 days  (`/v5/execution/list` maxRange)
 *   - bingx:  7 days  (`/openApi/spot/v1/trade/historyOrders`)
 *   - okx:    90 days (`/api/v5/account/bills-archive` 3-month max)
 *   - bitget: 90 days (tax endpoint already chunks via другой module)
 *   - mexc:   30 days (`/api/v3/myTrades`)
 *
 * UCB B1.5 — отдельный фундаментальный модуль для closure data-gap
 * слоя 1 (Sync data integrity), без него UCB-методология не работает
 * для активов купленных >7 дней назад.
 */

import type { Exchange } from "ccxt";

import type { ExchangeId } from "./cex.types.js";

const DAY_MS = 86_400_000;

/**
 * Сколько дней истории тянем при первом sync. 3 года = ~1095 дней —
 * закрывает типичные user-портфели + tax-reporting за полные 3 года.
 *
 * Override через env `CAPFLOW_CEX_HISTORICAL_DAYS`.
 */
export const HISTORICAL_DAYS_DEFAULT = 1095;

/**
 * Per-exchange окно для `fetchMyTrades` chunking. `null` = биржа сама
 * умеет отдавать всю историю без time-фильтра (например, Bitget retail
 * tax endpoint — у него своя логика и он chunks по 30 дням в `cex.p2p.bitget.ts`).
 */
export const TRADE_WINDOW_DAYS: Record<ExchangeId, number | null> = {
  bybit: 7,
  bingx: 7,
  okx: 90,
  mexc: 30,
  bitget: null, // bitget tax endpoint самостоятельно chunks
};

/**
 * **Hard cap** на сколько дней назад биржа вообще отдаёт историю. Если
 * мы запросим раньше — биржа отдаёт error (Bybit: `10001 Can't query
 * order earlier than 2 years`). HISTORICAL_DAYS_DEFAULT (3 года)
 * truncate'ится до этого значения.
 *
 * Источники:
 *   - bybit:  2 года (Bybit V5 API docs, /v5/execution/list)
 *   - bingx:  6 мес (BingX Spot API limit на `lastDays=180`)
 *   - okx:    7 лет (OKX bills-archive)
 *   - mexc:   ~3 мес (MEXC fetchMyTrades без historical premium)
 *   - bitget: 90 дней (через tax endpoint — handled elsewhere)
 */
export const TRADE_MAX_LOOKBACK_DAYS: Record<ExchangeId, number> = {
  // Safety margin = 10 days. Bybit при 730 days дал `Can't query order
  // earlier than 2 years` — их «2 года» строгое, без leap-year-skew.
  // 720 даёт буфер на наши window-shifts и часовые пояса.
  bybit: 720,
  // BingX docs: spot trade history `startTime` ≤ 180 days lookback.
  bingx: 180,
  okx: 2555, // ~7 лет
  mexc: 90,
  bitget: 90,
};

/**
 * Per-exchange окно для `fetchDeposits` / `fetchWithdrawals`.
 * Большинство бирж позволяют 90 дней per запрос для transfers.
 */
export const TRANSFER_WINDOW_DAYS: Record<ExchangeId, number | null> = {
  bybit: 30, // `/v5/asset/deposit/query-record` 30 days max
  bingx: 90, // BingX позволяет 90 days
  okx: 90,
  mexc: 90,
  bitget: 90,
};

/**
 * Hard-cap на сколько дней назад биржа отдаёт deposit/withdrawal-историю.
 * Те же причины что у TRADE_MAX_LOOKBACK_DAYS — без cap'а 3-летний default
 * биржа отвергнет.
 */
export const TRANSFER_MAX_LOOKBACK_DAYS: Record<ExchangeId, number> = {
  bybit: 720, // 2 года safety margin (как у trades)
  bingx: 1080, // BingX deposit history 3 года
  okx: 2555, // OKX bills-archive до 7 лет
  mexc: 365, // MEXC withdraw/deposit ~1 год
  bitget: 365,
};

/**
 * UCB B2.5: для каких бирж `fetchDeposits/Withdrawals` БЕЗ coin-filter'а
 * возвращает empty array. Bybit `/v5/asset/...query-record` требует
 * `coin` param, иначе вернёт `[]` без ошибки → пользователь видит 0
 * deposits даже если их сотни.
 *
 * Когда `true` — `syncTransfers` итерирует по всем asset'ам из balance
 * (и по основным stablecoin'ам как fallback) и склеивает результат.
 */
export const TRANSFER_REQUIRES_COIN_FILTER: Record<ExchangeId, boolean> = {
  bybit: true,
  bingx: true, // BingX тоже только по coin (мы видели 0 deposits)
  okx: false, // OKX отдаёт без filter
  mexc: false,
  bitget: false,
};

export interface ChunkedFetchOptions {
  /** Start timestamp (ms). Если не задан — `now - HISTORICAL_DAYS_DEFAULT × day`. */
  readonly since?: number;
  /** End timestamp (ms). Default = now. */
  readonly until?: number;
  /** Окно одного запроса в днях. */
  readonly windowDays: number;
  /** Опционально: символ для бирж где `fetchMyTrades` requires it (BingX/Bitget). */
  readonly symbol?: string;
  /** Hard cap на кол-во итераций (safety). Default 200 = ~4 года при 7-day окне. */
  readonly maxIterations?: number;
  /** Доп. params в CCXT call (limit, etc.). */
  readonly extraParams?: Record<string, unknown>;
}

export interface ChunkedFetchResult<T> {
  readonly items: T[];
  /** Сколько окон реально дёрнули. */
  readonly windows: number;
  /** Окна с error'ами — UI/audit может surface. */
  readonly errors: Array<{ from: number; to: number; message: string }>;
}

/**
 * Loop'ит CCXT-method по time-окнам и возвращает сводный array.
 *
 * Метод `(symbol, since, limit, params)` ⇒ `Promise<T[]>`. Это match'ит
 * CCXT-сигнатуру `fetchMyTrades`, `fetchDeposits`, `fetchWithdrawals`.
 *
 * Error'ы по одному window'у НЕ прерывают loop — записываются в
 * `errors` и переходим к следующему window'у. Без этого один dead-time
 * window обрушит весь backfill (и user снова получит 0 trades).
 *
 * **Idempotent**: повторный запуск с те же `since/until` даст те же
 * items — uniqueness гарантируется на DB уровне через
 * `(cex_account_id, exchange_trade_id)` unique index.
 */
export async function chunkedFetch<T>(
  fn: (symbol: string | undefined, since: number, limit: number | undefined, params: Record<string, unknown>) => Promise<T[]>,
  opts: ChunkedFetchOptions,
): Promise<ChunkedFetchResult<T>> {
  const now = Date.now();
  const until = opts.until ?? now;
  const since = opts.since ?? now - HISTORICAL_DAYS_DEFAULT * DAY_MS;
  if (since >= until) {
    return { items: [], windows: 0, errors: [] };
  }
  if (opts.windowDays <= 0) {
    throw new Error(`windowDays must be positive (got ${opts.windowDays})`);
  }
  const windowMs = opts.windowDays * DAY_MS;
  const maxIterations = opts.maxIterations ?? 200;

  const items: T[] = [];
  const errors: ChunkedFetchResult<T>["errors"] = [];
  let cursor = since;
  let windows = 0;

  while (cursor < until && windows < maxIterations) {
    const windowEnd = Math.min(cursor + windowMs, until);
    windows += 1;
    try {
      const params: Record<string, unknown> = {
        ...(opts.extraParams ?? {}),
        until: windowEnd,
      };
      // Transient retry: undici-level "fetch failed" / ECONNRESET /
      // ETIMEDOUT / DNS jitter happens occasionally (Bitget's
      // `/spot/public/coins` endpoint is especially flaky from RU/CIS
      // IPs). One retry with backoff turns a single network blip into
      // an invisible delay instead of a window-wide error.
      let chunk: T[];
      try {
        chunk = await fn(opts.symbol, cursor, undefined, params);
      } catch (firstErr) {
        const m = (firstErr as Error).message ?? "";
        const transient =
          /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network|timeout/i.test(
            m,
          );
        if (!transient) throw firstErr;
        await new Promise((r) => setTimeout(r, 2_000));
        chunk = await fn(opts.symbol, cursor, undefined, params);
      }
      if (Array.isArray(chunk) && chunk.length > 0) {
        items.push(...chunk);
      }
    } catch (e) {
      errors.push({
        from: cursor,
        to: windowEnd,
        message: (e as Error).message?.slice(0, 200) ?? "unknown",
      });
    }
    // Сдвигаем cursor строго на windowEnd чтобы избежать infinite loop
    // если биржа вернула items в пределах окна.
    cursor = windowEnd;
  }
  return { items, windows, errors };
}

/**
 * Convenience wrapper для `fetchMyTrades` с правильным окном per-биржа.
 * Используется в `cex.service.ts → fetchAndStoreTrades`.
 *
 * Если для биржи `TRADE_WINDOW_DAYS[id]` === null — fallback на
 * прямой single-call (биржа handles backfill сама).
 */
export async function chunkedFetchMyTrades(
  client: Exchange,
  exchangeId: ExchangeId,
  opts: Omit<ChunkedFetchOptions, "windowDays">,
): Promise<ChunkedFetchResult<unknown>> {
  // Cap'аем since per-biржа: запрос раньше maxLookback всё равно вернёт
  // error. Без этого: 3-летний default ломает Bybit (`Can't query
  // earlier than 2 years` → 53 окна failed → throw → user видит 0 trades).
  const maxLookbackDays = TRADE_MAX_LOOKBACK_DAYS[exchangeId];
  const earliestAllowed = Date.now() - maxLookbackDays * DAY_MS;
  const cappedSince =
    opts.since !== undefined ? Math.max(opts.since, earliestAllowed) : earliestAllowed;
  const cappedOpts = { ...opts, since: cappedSince };

  const windowDays = TRADE_WINDOW_DAYS[exchangeId];
  if (windowDays === null) {
    // Биржа сама chunks — делаем single call.
    try {
      const result = (await client.fetchMyTrades(opts.symbol, cappedSince)) as unknown[];
      return { items: result, windows: 1, errors: [] };
    } catch (e) {
      return {
        items: [],
        windows: 1,
        errors: [{ from: cappedSince, to: Date.now(), message: (e as Error).message }],
      };
    }
  }
  return chunkedFetch<unknown>(
    (symbol, since, limit, params) =>
      client.fetchMyTrades(symbol, since, limit, params) as Promise<unknown[]>,
    { ...cappedOpts, windowDays },
  );
}

/**
 * UCB B2: chunked deposits/withdrawals — closure data-gap слоя 1 для
 * trasfers. Без него на BingX user'а 0 deposits хотя за 3 года их сотни.
 * Параметры fetchDeposits/fetchWithdrawals: `(asset, since, limit, params)`.
 * Большинство бирж требуют `since` и `until` через params, иначе отдают
 * только последние 7-30 дней. Per-exchange `TRANSFER_WINDOW_DAYS`.
 */
export async function chunkedFetchTransfers(
  fetchFn: (
    asset: string | undefined,
    since: number,
    limit: number | undefined,
    params: Record<string, unknown>,
  ) => Promise<unknown[]>,
  exchangeId: ExchangeId,
  opts: Omit<ChunkedFetchOptions, "windowDays">,
): Promise<ChunkedFetchResult<unknown>> {
  const maxLookbackDays = TRANSFER_MAX_LOOKBACK_DAYS[exchangeId];
  const earliestAllowed = Date.now() - maxLookbackDays * DAY_MS;
  const cappedSince =
    opts.since !== undefined ? Math.max(opts.since, earliestAllowed) : earliestAllowed;

  const windowDays = TRANSFER_WINDOW_DAYS[exchangeId];
  if (windowDays === null) {
    // Биржа сама chunks — single call.
    try {
      const result = await fetchFn(opts.symbol, cappedSince, undefined, {});
      return { items: result, windows: 1, errors: [] };
    } catch (e) {
      return {
        items: [],
        windows: 1,
        errors: [{ from: cappedSince, to: Date.now(), message: (e as Error).message }],
      };
    }
  }
  return chunkedFetch<unknown>(fetchFn, {
    ...opts,
    since: cappedSince,
    windowDays,
  });
}

/**
 * UCB B2.5: итерация transfer-history **по каждому coin отдельно** для
 * бирж где `fetchDeposits/Withdrawals` без filter'а отдаёт empty.
 *
 * Для каждого asset:
 *   1. Если asset в `assets` (из balance + stable-fallback) — pull его
 *      историю через окно time-chunking (per `TRANSFER_WINDOW_DAYS`).
 *   2. Aggregate все items + errors во единый ChunkedFetchResult.
 *
 * Дедупликация — на DB-уровне через unique index. Это OK что один и
 * тот же transfer вернётся если он лежит в нескольких coin-pages (не
 * происходит, но safe).
 */
export async function chunkedFetchTransfersPerAsset(
  fetchFn: (
    asset: string | undefined,
    since: number,
    limit: number | undefined,
    params: Record<string, unknown>,
  ) => Promise<unknown[]>,
  exchangeId: ExchangeId,
  assets: readonly string[],
  opts: Omit<ChunkedFetchOptions, "windowDays" | "symbol">,
): Promise<ChunkedFetchResult<unknown>> {
  if (!TRANSFER_REQUIRES_COIN_FILTER[exchangeId]) {
    // Биржа handles без filter — просто chunkedFetchTransfers.
    return chunkedFetchTransfers(fetchFn, exchangeId, opts);
  }
  const allItems: unknown[] = [];
  const allErrors: ChunkedFetchResult<unknown>["errors"] = [];
  let totalWindows = 0;
  const unique = Array.from(new Set(assets.filter((a) => a && a.length > 0)));
  for (const asset of unique) {
    const r = await chunkedFetchTransfers(fetchFn, exchangeId, {
      ...opts,
      symbol: asset,
    });
    if (r.items.length > 0) allItems.push(...r.items);
    // Filter out известные "soft" errors которые НЕ означают что что-то
    // сломалось — это просто asset не listed на бирже (например EOS на
    // Bybit). Без filter'а первый такой error попадает в `errors[0]` и
    // syncTransfers surface'ит его как «sync failed», хотя на самом деле
    // остальные assets sync'нулись успешно.
    const meaningfulErrors = r.errors.filter(
      (e) =>
        !/does not have currency code|does not have market|unknown currency|unsupported currency/i.test(
          e.message,
        ),
    );
    if (meaningfulErrors.length > 0) allErrors.push(...meaningfulErrors);
    totalWindows += r.windows;
  }
  return { items: allItems, windows: totalWindows, errors: allErrors };
}
