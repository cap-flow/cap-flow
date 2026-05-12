import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { accounts } from "./accounts.js";

/**
 * Per-account override of the global `coingecko_registry`.
 *
 * Used when an account holds an exotic token whose `symbol → coingecko_id`
 * mapping is wrong or missing in the global registry. Resolution at runtime:
 *
 *   1. Check `cg_id_overrides` for (account_id, symbol) — wins if present.
 *   2. Fall back to `coingecko_registry` (global).
 *   3. If still missing — the operation surfaces as "unmapped" in the admin
 *      audit dashboard (Phase 5) so the global registry can be enriched.
 */
export const cgIdOverrides = pgTable(
  "cg_id_overrides",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    coingeckoId: text("coingecko_id").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.symbol] }),
    index("cg_id_overrides_account_idx").on(table.accountId),
  ]
);

export type CgIdOverrideRow = typeof cgIdOverrides.$inferSelect;
export type NewCgIdOverrideRow = typeof cgIdOverrides.$inferInsert;
