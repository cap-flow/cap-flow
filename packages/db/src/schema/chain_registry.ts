import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Global chain registry — what blockchains the platform supports.
 *
 * Single source of truth for `chain_id → name / fee_token / default RPC`,
 * shared across all users. Per-account custom RPC overrides may live in a
 * separate table later if demand appears.
 */
export const chainRegistry = pgTable(
  "chain_registry",
  {
    chainId: integer("chain_id").primaryKey(),
    name: text("name").notNull(),
    /** Native token symbol used to pay gas (ETH / BNB / MATIC / …). */
    feeToken: text("fee_token").notNull(),
    /** Whether this chain is enabled platform-wide (admin can disable). */
    enabled: boolean("enabled").notNull().default(true),
    /** Coingecko platform slug used to look up token contracts on this chain. */
    coingeckoPlatform: text("coingecko_platform"),
    /** Default RPC URL hint — actual API key comes from server env. */
    defaultRpcHint: text("default_rpc_hint"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("chain_registry_enabled_idx").on(table.enabled)]
);

export type ChainRow = typeof chainRegistry.$inferSelect;
export type NewChainRow = typeof chainRegistry.$inferInsert;
