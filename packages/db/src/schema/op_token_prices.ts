import {
  bigint,
  boolean,
  index,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * UCB B1 — deterministic per-operation historical price cache (shared, global).
 *
 * Root cause this fixes (POS-005, confirmed 2026-05-31): `chain_operations.raw.
 * movement[].usd` is priced at SYNC time, not fixed to the block — so the same
 * on-chain tx, re-synced or fetched by a second account tracking the same
 * address, gets a DIFFERENT USD value (measured: 560/2260 txs shared across
 * wallets, 156 diverge >1%, max 25.9%). That makes cost basis non-deterministic.
 *
 * This table anchors price to the OBJECTIVE fact: the DefiLlama coin key + the
 * hour bucket of the op. One row per (coin, hour_bucket), shared across ALL
 * users — identical regardless of which account/sync produced the op.
 *
 * Keyed by `coin` (= `defillamaCoinKey(chain, tokenId, symbol)` from
 * `@cap-flow/ucb/pricing`) + `hour_bucket` (= `bucketTs(opTime)` =
 * Math.floor(t/3600)*3600, epoch seconds). The served map key is
 * `${coin}|${hour_bucket}` — byte-for-byte identical to the client's
 * `cacheKeyFor()` histPrices Map, so server cost basis matches the client.
 *
 * DEVIATION from master-plan B1 (which proposed PK `(chain, token_id,
 * hour_bucket)`): we key by `coin` instead, because `defillamaCoinKey` is the
 * actual unit DefiLlama prices (multiple addresses / native / EUR-stables all
 * collapse to one coin, e.g. `coingecko:euro-coin`), and it matches the client
 * Map key exactly. `chain`/`token_id` kept as descriptive columns.
 *
 * R1 (do NOT reuse `historical_prices(symbol,date)`): this table is keyed by the
 * DefiLlama coin, never by bare symbol — so EUR-stable (`coingecko:euro-coin`)
 * never collides with EUR-fiat (`historical_prices.symbol='EUR'`).
 *
 * R5 (outage guard): NEVER insert a row for a failed/zero lookup. A row exists
 * only when `priced_ok=true`; misses are simply absent (mirrors the client's
 * `hasHistPrices:false` drop). `priced_ok` column retained for explicit
 * negative-cache use later, defaulting true.
 */
export const opTokenPrices = pgTable(
  "op_token_prices",
  {
    /** `defillamaCoinKey` output, e.g. `ethereum:0x...`, `coingecko:euro-coin`. */
    coin: text("coin").notNull(),
    /** `bucketTs(opTime)` = floor(epochSeconds/3600)*3600. */
    hourBucket: bigint("hour_bucket", { mode: "number" }).notNull(),
    priceUsd: numeric("price_usd", { precision: 28, scale: 8 }).notNull(),
    /** R5: true = real price served; false reserved for negative-cache. */
    pricedOk: boolean("priced_ok").notNull().default(true),
    /** Descriptive (not part of PK): origin chain of the op. */
    chain: text("chain").notNull(),
    /** Descriptive: contract address or native sentinel from the op. */
    tokenId: text("token_id"),
    /** `defillama` | `op_raw` (fallback to the op's own movement.usd). */
    source: text("source").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.coin, table.hourBucket] }),
    index("op_token_prices_bucket_idx").on(table.hourBucket),
  ]
);

export type OpTokenPriceRow = typeof opTokenPrices.$inferSelect;
export type NewOpTokenPriceRow = typeof opTokenPrices.$inferInsert;
