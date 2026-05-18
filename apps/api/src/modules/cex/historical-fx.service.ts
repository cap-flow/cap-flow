/**
 * UCB D2: Historical FX rates для P2P в non-USD фиате (RUB / EUR / GBP / …).
 *
 * Без этого: P2P-buy USDT за 1000 RUB → cost basis = 1000 USDT × $1 = $1000
 * (потому что USDT stable), но для buy BTC за 1000 RUB вместо честного
 * `1000 × FX[RUB/USD]` мы возвращали 0 (unknown). Это ломало P2P→trades→
 * withdrawal цепочку и дальше cost basis крипты на on-chain wallet'е.
 *
 * Реализация:
 *   - Reuse `historical_prices` table (symbol = ISO-4217 currency code,
 *     price_usd = rate to USD). Cache survives restarts, shared across
 *     users. No новой schema migration не нужно.
 *   - Source: exchangerate.host (free, no API key, supports any base).
 *     Endpoint format: `https://api.exchangerate.host/<YYYY-MM-DD>?base=<CCY>&symbols=USD`
 *   - Async batch fetch — caller pre-fetches все нужные (currency, date)
 *     pairs одним вызовом до основной calc loop, чтобы не вызывать
 *     HTTP в горячем пути.
 *
 * Edge cases:
 *   - currency=USD → return 1 без call.
 *   - upstream timeout / failure → return null, caller fallback'ится на
 *     existing stable-asset 1:1 logic.
 *   - rate <= 0 / NaN → return null.
 */
import { schema, type Database } from "@cap-flow/db";
import { and, eq, inArray } from "drizzle-orm";

const EXCHANGERATE_HOST_BASE = "https://api.exchangerate.host";
const FETCH_TIMEOUT_MS = 5000;

type CurrencyCode = string; // ISO-4217 (3-letter), e.g. "RUB", "EUR"

interface FxNeed {
  readonly currency: CurrencyCode;
  /** Trade timestamp; rate looked up at this date (YYYY-MM-DD). */
  readonly date: Date;
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function compositeKey(currency: CurrencyCode, date: Date): string {
  return `${currency.toUpperCase()}|${dateKey(date)}`;
}

export class HistoricalFxService {
  constructor(private readonly db: Database) {}

  /**
   * Get rate `1 <currency> = ? USD` на указанную дату.
   * `USD → 1.0` без call. Cached в `historical_prices` table.
   */
  async getRateToUsd(
    currency: CurrencyCode,
    date: Date,
  ): Promise<number | null> {
    const sym = currency.toUpperCase();
    if (sym === "USD") return 1;

    const dateStr = dateKey(date);
    const cached = await this.db
      .select({ rate: schema.historicalPrices.priceUsd })
      .from(schema.historicalPrices)
      .where(
        and(
          eq(schema.historicalPrices.symbol, sym),
          eq(schema.historicalPrices.date, dateStr),
        ),
      )
      .limit(1);
    if (cached[0]) {
      const v = Number(cached[0].rate);
      if (Number.isFinite(v) && v > 0) return v;
    }

    const fetched = await this.fetchFromUpstream(sym, dateStr);
    if (fetched == null) return null;

    // Cache idempotent — race-safe через onConflictDoNothing.
    await this.db
      .insert(schema.historicalPrices)
      .values({
        symbol: sym,
        date: dateStr,
        priceUsd: String(fetched),
        source: "exchangerate.host",
      })
      .onConflictDoNothing();

    return fetched;
  }

  /**
   * Batch-fetch FX для нескольких (currency, date) пар. Deduplicates,
   * проверяет cache одним SELECT, fetch'ит missing параллельно.
   *
   * Returns `Map<composite-key, rate>` где key = `${currency}|${YYYY-MM-DD}`.
   * Caller использует `compositeKeyOf(currency, date)` для lookup.
   */
  async batchGetRates(needs: ReadonlyArray<FxNeed>): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (needs.length === 0) return result;

    // Dedupe.
    const uniqueMap = new Map<string, FxNeed>();
    for (const n of needs) {
      const c = n.currency.toUpperCase();
      if (c === "USD") {
        result.set(`USD|${dateKey(n.date)}`, 1);
        continue;
      }
      uniqueMap.set(compositeKey(c, n.date), { ...n, currency: c });
    }
    const unique = [...uniqueMap.values()];
    if (unique.length === 0) return result;

    // Bulk cache lookup: WHERE (symbol, date) IN (...).
    const symbols = [...new Set(unique.map((n) => n.currency))];
    const dates = [...new Set(unique.map((n) => dateKey(n.date)))];
    const cached = await this.db
      .select({
        symbol: schema.historicalPrices.symbol,
        date: schema.historicalPrices.date,
        rate: schema.historicalPrices.priceUsd,
      })
      .from(schema.historicalPrices)
      .where(
        and(
          inArray(schema.historicalPrices.symbol, symbols),
          inArray(schema.historicalPrices.date, dates),
        ),
      );
    const cacheMap = new Map<string, number>();
    for (const c of cached) {
      const v = Number(c.rate);
      if (Number.isFinite(v) && v > 0) {
        cacheMap.set(`${c.symbol}|${c.date}`, v);
      }
    }

    // Pour cache hits into result.
    const missing: FxNeed[] = [];
    for (const n of unique) {
      const k = compositeKey(n.currency, n.date);
      const hit = cacheMap.get(k);
      if (hit != null) result.set(k, hit);
      else missing.push(n);
    }
    if (missing.length === 0) return result;

    // Fetch missing concurrent (с capping чтобы не положить upstream).
    // exchangerate.host = free tier ~100 req/min, мы редко делаем > 10
    // FX-pairs per compute. Concurrency 5 — safe.
    const CONCURRENCY = 5;
    for (let i = 0; i < missing.length; i += CONCURRENCY) {
      const chunk = missing.slice(i, i + CONCURRENCY);
      const fetched = await Promise.all(
        chunk.map(async (n) => {
          const r = await this.fetchFromUpstream(n.currency, dateKey(n.date));
          return { n, r };
        }),
      );
      const inserts: Array<{ symbol: string; date: string; rate: number }> = [];
      for (const { n, r } of fetched) {
        if (r == null) continue;
        const k = compositeKey(n.currency, n.date);
        result.set(k, r);
        inserts.push({
          symbol: n.currency,
          date: dateKey(n.date),
          rate: r,
        });
      }
      if (inserts.length > 0) await this.bulkInsert(inserts);
    }
    return result;
  }

  /** Helper для caller'ов: build map-lookup key. */
  static keyOf(currency: CurrencyCode, date: Date): string {
    return compositeKey(currency, date);
  }

  private async fetchFromUpstream(
    currency: string,
    dateStr: string,
  ): Promise<number | null> {
    const url = `${EXCHANGERATE_HOST_BASE}/${dateStr}?base=${encodeURIComponent(currency)}&symbols=USD`;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      const body = (await res.json()) as {
        rates?: { USD?: number };
        success?: boolean;
      };
      if (body.success === false) return null;
      const rate = body.rates?.USD;
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
        return null;
      }
      return rate;
    } catch {
      return null;
    }
  }

  private async bulkInsert(
    rows: ReadonlyArray<{ symbol: string; date: string; rate: number }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.db
      .insert(schema.historicalPrices)
      .values(
        rows.map((r) => ({
          symbol: r.symbol,
          date: r.date,
          priceUsd: String(r.rate),
          source: "exchangerate.host",
        })),
      )
      .onConflictDoNothing();
  }
}
