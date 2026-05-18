/**
 * P2P-leg types — shared across exchange clients, repository and the
 * service layer.
 *
 * Why a separate file (vs. cex.types.ts):
 *   - keeps the slim CCXT-only types untouched
 *   - the P2P shape is fundamentally different (fiat currency, payment
 *     method, counterparty handle) and we don't want it leaking into
 *     spot/trade code paths
 */

import type { CexProxyConfig } from "./cex.proxy.js";
import type { CexCredentials, ExchangeId } from "./cex.types.js";

/**
 * Normalized P2P order shape that every exchange-specific client must
 * produce. Mirrors `packages/db/src/schema/cex_accounts.ts -> cexP2pOrders`.
 *
 *   side          — from USER perspective:
 *                   'buy'  = user received `asset`, paid `fiatAmount`
 *                   'sell' = user sent `asset`, received `fiatAmount`
 *   unitPrice     — fiatAmount / amount (denormalized — kept for queries).
 *   status        — exchange-specific lowercased token: 'completed',
 *                   'appealed', 'cancelled', 'pending' …
 *   executedAtMs  — settlement timestamp (ms since epoch).
 */
export interface P2pOrderLine {
  readonly id: string;
  readonly side: "buy" | "sell";
  readonly asset: string;
  readonly amount: number;
  /** Null when the exchange API doesn't expose the fiat leg
   *  (Bitget retail tax endpoint, for example, only returns crypto). */
  readonly fiatCurrency: string | null;
  readonly fiatAmount: number | null;
  readonly unitPrice: number | null;
  readonly counterparty: string | null;
  readonly paymentMethod: string | null;
  readonly status: string;
  readonly executedAtMs: number;
}

/**
 * Per-exchange P2P client. Implementations call their exchange's REST
 * API directly (CCXT doesn't unify P2P) and return normalized lines.
 *
 * `since` is an inclusive timestamp filter — pull everything from that
 * point onwards. Implementations are responsible for pagination.
 */
export interface IP2pClient {
  readonly exchange: ExchangeId;
  fetchP2pOrders(since?: Date): Promise<P2pOrderLine[]>;
}

/**
 * Factory returns:
 *   - an `IP2pClient` if the exchange is implemented and the credentials
 *     are sufficient to build a client
 *   - `null` if P2P isn't implemented for this exchange yet (Bybit / OKX
 *     / MEXC at the time of writing)
 *
 * The service layer turns `null` into a clear "not supported" message
 * so the UI can grey out the button instead of erroring opaquely.
 */
export type IP2pClientFactory = (
  exchange: ExchangeId,
  creds: CexCredentials,
  proxy?: CexProxyConfig | null
) => IP2pClient | null;

/** Result of a single P2P sync run. */
export interface P2pSyncResult {
  readonly ok: boolean;
  readonly supported: boolean;
  readonly newOrders: number;
  readonly error?: string;
}
