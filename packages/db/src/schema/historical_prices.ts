import {
  date,
  index,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Global historical price cache — one row per (symbol, date).
 *
 * Populated lazily as the platform computes cost basis / PnL: when a user's
 * portfolio refers to a (symbol, date) tuple not present here, the worker
 * fetches it from DefiLlama/CoinGecko and writes here. All subsequent
 * lookups for any user hit this cache.
 *
 * High-volume eventually — composite PK keeps lookups O(1) and prevents
 * duplicates.
 */
export const historicalPrices = pgTable(
  "historical_prices",
  {
    symbol: text("symbol").notNull(),
    date: date("date").notNull(),
    priceUsd: numeric("price_usd", { precision: 28, scale: 8 }).notNull(),
    /** Where the price came from (`defillama`, `coingecko`, `manual`). */
    source: text("source").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.symbol, table.date] }),
    index("historical_prices_date_idx").on(table.date),
  ]
);

export type HistoricalPriceRow = typeof historicalPrices.$inferSelect;
export type NewHistoricalPriceRow = typeof historicalPrices.$inferInsert;
