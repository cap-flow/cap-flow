import { createHmac } from "node:crypto";

import type { CexProxyConfig } from "./cex.proxy.js";
import type { CexCredentials, ExchangeId } from "./cex.types.js";
import type { IP2pClient, P2pOrderLine } from "./cex.p2p.types.js";

/**
 * Bitget P2P client. CCXT doesn't unify P2P, so we hit Bitget's REST
 * directly with their v2 HMAC signing scheme.
 *
 *   Signing recipe (Bitget v2):
 *     timestamp (ms) + method (UPPER) + requestPath + queryString + body
 *     ── HMAC-SHA256 with secret, base64-encoded
 *
 *   Headers:
 *     ACCESS-KEY, ACCESS-SIGN, ACCESS-TIMESTAMP, ACCESS-PASSPHRASE,
 *     locale=en-US, Content-Type=application/json
 *
 * Endpoint we use (and why):
 *
 *   GET /api/v2/tax/p2p-record
 *     - The ONLY P2P endpoint Bitget exposes to retail keys. Returns
 *       just the crypto leg of each P2P trade (coin / amount /
 *       transfer-in vs transfer-out / timestamp). The fiat side
 *       (currency, amount, price, counterparty, payment method) is
 *       NOT exposed here — those live behind the merchant-only
 *       `/api/v2/p2p/orderList`, which requires a registered merchant
 *       account and a separate API key scope.
 *     - For users without merchant status this is the best we can do:
 *       we record "user received 100 USDT via P2P on Mar 1" without
 *       the matching "for 9550 RUB via Sberbank". The UI surfaces
 *       missing fiat fields as "—" so it's obvious.
 *
 * Retention:
 *   - Bitget caps retail history at ~90 days. We default to that
 *     window when `since` isn't provided.
 *
 * To get richer (fiat-side) data we'd need to:
 *   1. Add merchant-mode toggle on the account
 *   2. Call `/api/v2/p2p/orderList` when merchant=true
 *   3. Merge crypto-leg from tax-record + fiat-leg from orderList
 *   not done in this iteration.
 */
const BITGET_HOST = "https://api.bitget.com";
const PAGE_SIZE = 100;
const MAX_PAGES = 50; // hard cap so a buggy cursor can't infinite-loop us
/**
 * Throttle between chunked requests. Bitget retail rate-limit is ~10
 * req/sec across all endpoints — without spacing we'd burst 13 calls
 * in <1s and trigger 429 every time. 350ms × 13 ≈ 4.6s per sync, which
 * fits comfortably under the limit while still being snappy.
 */
const REQUEST_GAP_MS = 350;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface BitgetTaxP2pRecord {
  readonly id?: string;
  readonly coin?: string;
  /** "transfer-in" | "transfer-out" — direction from user's wallet
   *  perspective. transfer-in = user received crypto (sold fiat,
   *  bought crypto) → side: "buy". */
  readonly p2pTaxType?: string;
  readonly balance?: string | number;
  readonly ts?: string | number;
}

interface BitgetEnvelope {
  readonly code?: string;
  readonly msg?: string;
  readonly data?: BitgetTaxP2pRecord[] | { list?: BitgetTaxP2pRecord[] };
}

export class BitgetP2pClient implements IP2pClient {
  public readonly exchange: ExchangeId = "bitget";

  constructor(
    private readonly creds: CexCredentials,
    private readonly proxy: CexProxyConfig | null = null
  ) {
    if (!creds.apiPassphrase) {
      throw new Error("BitgetP2pClient requires apiPassphrase");
    }
  }

  async fetchP2pOrders(since?: Date): Promise<P2pOrderLine[]> {
    const out: P2pOrderLine[] = [];

    // Bitget P2P API retains ~90 days of retail history; older queries
    // are silently empty or error out. Default to that window.
    const BITGET_MAX_HISTORY_MS = 90 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const sinceMs = since
      ? Math.max(since.getTime(), now - BITGET_MAX_HISTORY_MS)
      : now - BITGET_MAX_HISTORY_MS;

    // The tax/p2p-record endpoint does NOT support cursor pagination —
    // it caps at 100 rows per request. To walk all history we slide
    // the time window backwards in 30-day chunks (90 days ⇒ 3 calls,
    // well under any reasonable rate limit). 30d is below Bitget's
    // implicit per-window cap for retail traders.
    const CHUNK_MS = 30 * 24 * 60 * 60 * 1000;
    for (let page = 0; page < MAX_PAGES; page++) {
      const windowEnd = Math.min(now, sinceMs + (page + 1) * CHUNK_MS);
      const windowStart = sinceMs + page * CHUNK_MS;
      if (windowStart >= now) break;
      if (page > 0) await sleep(REQUEST_GAP_MS);

      const items = await this.request("/api/v2/tax/p2p-record", {
        startTime: String(windowStart),
        endTime: String(windowEnd),
        limit: String(PAGE_SIZE),
      });
      for (const raw of items) {
        const line = normalizeBitgetTaxP2pRecord(raw);
        if (line) out.push(line);
      }
      if (windowEnd >= now) break;
    }
    return out;
  }

  /**
   * Signed GET with auto-retry on HTTP 429 (Bitget rate-limit). Retries
   * once after a 2s back-off; if it still rate-limits we surface the
   * error so the user can manually retry later.
   *
   * Signing string: `timestamp + "GET" + requestPath + queryString`.
   * No body for GETs.
   */
  private async request(
    path: string,
    query: Record<string, string>
  ): Promise<BitgetTaxP2pRecord[]> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.doRequest(path, query);
      if (!result.retryable) return result.data;
      // Bitget asks us to back off — wait 2s and try once more.
      if (attempt === 0) {
        await sleep(2_000);
        continue;
      }
      throw new Error(result.error);
    }
    return [];
  }

  private async doRequest(
    path: string,
    query: Record<string, string>
  ): Promise<
    | { retryable: false; data: BitgetTaxP2pRecord[] }
    | { retryable: true; error: string }
  > {
    const ts = Date.now().toString();
    const qs = new URLSearchParams(query).toString();
    const requestPath = qs ? `${path}?${qs}` : path;
    const sign = createHmac("sha256", this.creds.apiSecret)
      .update(ts + "GET" + requestPath)
      .digest("base64");

    // Native fetch (Node 22+) accepts an undici Dispatcher for proxy
    // routing. When `proxy` is null we omit the field entirely so
    // requests use the default agent — important for tests that
    // don't carry a proxy config.
    const baseInit: RequestInit = {
      method: "GET",
      headers: {
        "ACCESS-KEY": this.creds.apiKey,
        "ACCESS-SIGN": sign,
        "ACCESS-TIMESTAMP": ts,
        "ACCESS-PASSPHRASE": this.creds.apiPassphrase!,
        "Content-Type": "application/json",
        locale: "en-US",
      },
    };
    // `dispatcher` is a Node-specific extension to RequestInit (undici)
    // and not in the standard lib.dom types — set it via assertion when
    // we actually have a proxy. Without it we drop through to the
    // default global dispatcher (direct connection).
    const fetchInit = this.proxy?.dispatcher
      ? ({
          ...baseInit,
          dispatcher: this.proxy.dispatcher,
        } as unknown as RequestInit)
      : baseInit;
    const res = await fetch(`${BITGET_HOST}${requestPath}`, fetchInit);

    // HTTP-level rate limit. Bitget returns plain "Too Many Requests"
    // without the JSON envelope on 429, so we check status first.
    if (res.status === 429) {
      return {
        retryable: true,
        error:
          "Bitget rate-limit (HTTP 429). Сделайте паузу 10–30 секунд и попробуйте снова. " +
          "Скоупы ключа здесь ни при чём — это лимит запросов в секунду.",
      };
    }

    const text = await res.text();
    let parsed: BitgetEnvelope;
    try {
      parsed = JSON.parse(text) as BitgetEnvelope;
    } catch {
      throw new Error(
        `Bitget P2P returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`
      );
    }

    if (parsed.code && parsed.code !== "00000") {
      // Bitget application-level rate-limit (similar idea, different
      // surface): codes 30001/30007 — "Request over limit".
      if (parsed.code === "30001" || parsed.code === "30007") {
        return {
          retryable: true,
          error: `Bitget rate-limit code=${parsed.code} (${parsed.msg ?? "request over limit"}). Сделайте паузу 10–30 секунд и попробуйте снова.`,
        };
      }
      const hint =
        parsed.code === "40037" || parsed.code === "40034"
          ? " — у ключа нет нужного scope. Пересоздайте ключ с правом Read во всех разделах включая Tax/Finance."
          : "";
      throw new Error(
        `Bitget P2P error code=${parsed.code} msg="${parsed.msg ?? ""}"${hint}`
      );
    }

    const list = Array.isArray(parsed.data)
      ? parsed.data
      : (parsed.data?.list ?? []);
    return { retryable: false, data: list };
  }
}

/**
 * Map a Bitget tax P2P record into our normalized shape. The tax
 * endpoint exposes only the crypto leg — fiat fields are null because
 * Bitget doesn't return them to retail keys.
 *
 *   p2pTaxType (TAX perspective — about FIAT direction, not crypto):
 *     "transfer-in"  → fiat came IN  → user SOLD crypto for fiat → "sell"
 *     "transfer-out" → fiat went OUT → user BOUGHT crypto for fiat → "buy"
 *
 * Note the counter-intuitive mapping: this is a /tax/ endpoint, so
 * "transfer-in" is FROM the user's tax/money point of view ("money
 * came in"), NOT from the spot-wallet point of view. User confirmed
 * direction with a 2026-05-06 sale (gave USDT, received VND): Bitget
 * tagged it "transfer-in" — i.e. fiat came in. If a future Bitget
 * docs revision swaps the semantics, this mapping needs flipping
 * (and the fixture test below should fail loudly).
 *
 * The plain "buy" / "sell" tokens are accepted unchanged as a
 * defensive fallback — some Bitget endpoints return them directly.
 *
 * Exported for testing — fixture-based tests pin the mapping so a
 * future Bitget rename surfaces immediately.
 */
export function normalizeBitgetTaxP2pRecord(
  r: BitgetTaxP2pRecord
): P2pOrderLine | null {
  if (!r.id) return null;
  const asset = (r.coin ?? "").toString().toUpperCase();
  if (!asset) return null;

  const t = (r.p2pTaxType ?? "").toString().toLowerCase();
  let side: "buy" | "sell";
  if (t === "transfer-in") side = "sell"; // fiat came in → user sold crypto
  else if (t === "transfer-out") side = "buy"; // fiat went out → user bought crypto
  else if (t === "buy") side = "buy";
  else if (t === "sell") side = "sell";
  else return null;

  const amount = parseNum(r.balance);
  if (!isFinite(amount) || amount <= 0) return null;

  const ts = parseNum(r.ts);
  if (!isFinite(ts) || ts <= 0) return null;

  return {
    id: r.id,
    side,
    asset,
    amount,
    fiatCurrency: null,
    fiatAmount: null,
    unitPrice: null,
    counterparty: null,
    paymentMethod: null,
    status: "completed", // tax endpoint only lists settled records
    executedAtMs: ts,
  };
}

function parseNum(v: string | number | undefined | null): number {
  if (v == null) return NaN;
  return typeof v === "number" ? v : parseFloat(v);
}
