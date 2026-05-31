import {
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { accounts } from "./accounts.js";
import { wallets } from "./wallets.js";
import { goldenCases } from "./golden_cases.js";

/**
 * UCB anomaly flag — a detector finding (Epic C). Mirror migration
 * 0025_golden_anomaly.sql.
 *
 * One row per (account, wallet, position, check) idempotency key. The
 * scheduled detector re-runs and UPSERTs: a still-tripping finding bumps
 * `lastSeenAt`; a finding that stopped tripping is auto-resolved.
 *
 * Lifecycle (mutable, unlike a golden case which is a frozen oracle):
 *   open → acknowledged → resolved | promoted (→ minted a golden_case).
 *
 * User-scoped: `accountId` (FK → accounts, cascade) for tenant isolation,
 * plus nullable `walletId` when the finding is position-scoped.
 *
 * IDEMPOTENCY-KEY NOTE: the master plan proposed (accountId, walletId,
 * checkId), but that collapses DISTINCT positions in the same wallet that trip
 * the same check into one row. We include `positionId` →
 * (accountId, walletId, positionId, checkId) with NULLS NOT DISTINCT (PG16) so
 * account-level findings (null wallet/position) still dedupe correctly. The
 * unique constraint is enforced in SQL (`NULLS NOT DISTINCT`); the Drizzle
 * uniqueIndex below is for type/studio only.
 */
export const anomalyFlags = pgTable(
  "anomaly_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** Set when the finding is position-scoped; null for account-level checks. */
    walletId: uuid("wallet_id").references(() => wallets.id, {
      onDelete: "cascade",
    }),

    // ── Subject ────────────────────────────────────────────────────────
    positionId: text("position_id"),
    chain: text("chain"),
    protocolId: text("protocol_id"),
    marketKey: text("market_key"),

    // ── Finding ────────────────────────────────────────────────────────
    /** Stable check identifier, e.g. "pnl_pct_out_of_band". */
    checkId: text("check_id").notNull(),
    /** Optional coarser grouping/type label. */
    anomalyType: text("anomaly_type"),
    /** "info" | "warn" | "error". */
    severity: text("severity").notNull(),
    /** "pre" (snapshot-only checks) | "post" (canonical, post-port checks). */
    phase: text("phase").notNull().default("pre"),
    observedValue: numeric("observed_value", { precision: 20, scale: 6 }),
    /** Expected value if a golden exists; null otherwise. */
    expectedValue: numeric("expected_value", { precision: 20, scale: 6 }),
    detail: jsonb("detail"),
    /** Set on promote / for golden_case_drift findings. */
    goldenCaseId: uuid("golden_case_id").references(() => goldenCases.id, {
      onDelete: "set null",
    }),

    // ── Lifecycle ──────────────────────────────────────────────────────
    /** "open" | "acknowledged" | "resolved" | "promoted". */
    status: text("status").notNull().default("open"),
    detectorVersion: text("detector_version"),
    resolvedNote: text("resolved_note"),

    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    // NB: real NULLS NOT DISTINCT semantics enforced by the SQL migration.
    uniqueIndex("anomaly_flags_idem_uq").on(
      table.accountId,
      table.walletId,
      table.positionId,
      table.checkId,
    ),
    index("anomaly_flags_status_idx").on(table.status),
    index("anomaly_flags_wallet_idx").on(table.walletId),
  ],
);

export type AnomalyFlagRow = typeof anomalyFlags.$inferSelect;
export type NewAnomalyFlagRow = typeof anomalyFlags.$inferInsert;
