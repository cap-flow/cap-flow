import {
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { accounts } from "./accounts.js";

/**
 * Portfolio snapshots — one row per (account, date, optional label).
 *
 * Existing table inherited from prior schema. Written by the BullMQ worker
 * (Phase 4) on each scheduled refresh; the user dashboard reads the most
 * recent row instead of recomputing on every page-load.
 *
 * `metrics` shape (jsonb, evolving — kept loose on purpose):
 *   {
 *     totalUsd: number, pnl24h: number, pnlAll: number,
 *     openPositions: number, refreshedFrom: string[]   // provider names
 *   }
 *
 * `positions` (jsonb, optional): per-position snapshot — only filled when
 * `is_manual = 'false'` and an automated refresh produced it. Manual rows
 * may leave it null and just record metrics.
 */
export const portfolioSnapshots = pgTable(
  "portfolio_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    legacyId: text("legacy_id").notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    label: text("label"),
    /** `text` (not boolean) — preserved from the legacy schema. Values:
     *  "true" / "false". The worker writes "false" for automated refreshes. */
    isManual: text("is_manual").notNull().default("false"),
    metrics: jsonb("metrics").notNull(),
    positions: jsonb("positions"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("portfolio_snapshots_legacy_uq").on(
      table.accountId,
      table.legacyId
    ),
    index("portfolio_snapshots_account_date_idx").on(
      table.accountId,
      table.date
    ),
  ]
);

export type PortfolioSnapshotRow = typeof portfolioSnapshots.$inferSelect;
export type NewPortfolioSnapshotRow = typeof portfolioSnapshots.$inferInsert;
