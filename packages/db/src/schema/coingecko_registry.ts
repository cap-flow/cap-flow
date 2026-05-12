import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Global registry of token-symbol → coingecko-id mapping.
 *
 * Reference data shared across all users. Per-account overrides for exotic
 * tokens live in `cg_id_overrides`.
 *
 * `contractAddresses` map: { "ethereum": "0xa0b8...", "polygon": "0x...", … }
 *   — used when a chain has multiple wrappers with the same symbol and we
 *   need to disambiguate which one the user actually holds.
 */
export const coingeckoRegistry = pgTable(
  "coingecko_registry",
  {
    /** Uppercase symbol — natural primary key the user types in the UI. */
    symbol: text("symbol").primaryKey(),
    coingeckoId: text("coingecko_id").notNull(),
    name: text("name"),
    contractAddresses: jsonb("contract_addresses").notNull().default({}),
    /** Optional: reorder lookup priority (lower = preferred). */
    priority: text("priority"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("coingecko_registry_coingecko_id_idx").on(table.coingeckoId),
    index("coingecko_registry_name_idx").on(table.name),
  ]
);

export type CoingeckoRow = typeof coingeckoRegistry.$inferSelect;
export type NewCoingeckoRow = typeof coingeckoRegistry.$inferInsert;
