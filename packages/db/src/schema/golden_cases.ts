import { sql } from "drizzle-orm";
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

import { wallets } from "./wallets.js";
import { users } from "./users.js";

/**
 * UCB golden case — a per-position EXPECTED-OUTPUT oracle for the cost-basis
 * engine. Mirror migration 0025_golden_anomaly.sql.
 *
 * A golden case is the regression anchor: it freezes "this exact position must
 * compute startUsd ≈ X (source-of-truth Y)". The committed JSON fixture (see
 * `fixturePath`) holds the frozen inputs; this row is the live oracle the
 * anomaly detector (Epic C) checks canonical output against.
 *
 * Deliberately SEPARATE from `chain_operation_annotations` (which is per-op,
 * mutable INPUT a user forces into the pipeline). A golden case is per-position
 * proven OUTPUT — conflating "what the user forced" with "what we proved
 * correct" is exactly the anti-pattern the annotations file warns about.
 *
 * User-scoped: every row carries `walletId` (FK → wallets, ON DELETE cascade);
 * queries are always wallet/account-scoped → row-level tenant isolation.
 *
 * Authoring/persistence ritual (3 durable layers: this DB row + committed
 * fixture + repo ledger + memory pointer): see
 * notes/decisions/ucb-server-port-master-plan.md and memory
 * `capflow_golden_case_authoring`.
 */
export const goldenCases = pgTable(
  "golden_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    walletId: uuid("wallet_id")
      .notNull()
      .references(() => wallets.id, { onDelete: "cascade" }),

    // ── Identity / durable anchor ──────────────────────────────────────
    /** OpenPosition.id at authoring time (format may drift — prefer anchor). */
    positionId: text("position_id").notNull(),
    chain: text("chain").notNull(),
    protocolId: text("protocol_id").notNull(),
    /** Durable on-chain anchor: V3/Velodrome NFT tokenId, lending receipt addr, null for CEX. */
    marketKey: text("market_key"),
    openHash: text("open_hash"),
    /** Human label, e.g. "POS-011". */
    label: text("label").notNull(),
    /**
     * A3.6 STABLE global identity: walletId|chain|protocolId|anchor|supply
     * (see @cap-flow/ucb positionKey). Unique across all users. Replaces the
     * unstable (walletId, positionId) identity — positionId is now display-only.
     */
    positionKey: text("position_key"),
    /**
     * 'golden' = position computes correctly (expected = frozen current value).
     * 'wrong'  = position is incorrect / suspicious — drives a fix; shown
     *            highlighted until the engine matches. (A3.5, migration 0026.)
     */
    kind: text("kind").notNull().default("golden"),
    /**
     * For kind='wrong' — which metric is off: 'start_usd' | 'fees' | 'apr' |
     * 'pnl' | 'current_value' | 'other'. Null for golden.
     */
    issue: text("issue"),

    // ── Oracle (expected output) ───────────────────────────────────────
    expectedStartUsd: numeric("expected_start_usd", { precision: 20, scale: 6 }),
    expectedNetStartUsd: numeric("expected_net_start_usd", {
      precision: 20,
      scale: 6,
    }),
    expectedPnlUsd: numeric("expected_pnl_usd", { precision: 20, scale: 6 }),
    /** Pass = within abs OR pct (whichever is looser). */
    toleranceAbsUsd: numeric("tolerance_abs_usd", { precision: 20, scale: 6 })
      .notNull()
      .default("1"),
    tolerancePct: numeric("tolerance_pct", { precision: 8, scale: 6 })
      .notNull()
      .default("0.02"),

    // ── Provenance ─────────────────────────────────────────────────────
    /** "etherscan_v2" | "krystal" | "revert_ui" | "manual" | … */
    sourceOfTruth: text("source_of_truth").notNull(),
    /** How ground truth was established (derivation steps). */
    provenanceNote: text("provenance_note"),
    methodologyVersion: text("methodology_version").notNull(),

    // ── Fixture linkage + lifecycle ────────────────────────────────────
    /** Repo path of the committed frozen fixture (offline replay). */
    fixturePath: text("fixture_path"),
    /**
     * A3.6 knowledge base: the on-chain operations that feed this position +
     * the cost-flow trace that yields the number (why it's correct, derived
     * from `chain_operations`). Shape: see web `buildPositionDerivation`.
     */
    derivation: jsonb("derivation"),
    /** "active" | "retired" (soft-retire, never hard-delete). */
    status: text("status").notNull().default("active"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /**
     * Learning-loop link: the anomaly this golden was promoted from. Soft
     * reference (no FK constraint) to avoid a circular dependency with
     * `anomaly_flags` (which FK-references golden_cases).
     */
    promotedFromAnomalyId: uuid("promoted_from_anomaly_id"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // A3.6: stable global identity, deduped among ACTIVE rows. (Partial
    // WHERE status='active' is enforced in SQL migration 0032 — replacing the
    // 0028 `WHERE position_key IS NOT NULL` index, which let NULL keys escape
    // dedup; the builder here is for type/studio.) Re-marking an active anchor
    // updates it; soft-retired history rows are excluded and never block it.
    uniqueIndex("golden_cases_active_position_key_uq")
      .on(table.positionKey)
      .where(sql`${table.status} = 'active'`),
    index("golden_cases_wallet_idx").on(table.walletId),
    index("golden_cases_chain_market_idx").on(table.chain, table.marketKey),
    index("golden_cases_label_idx").on(table.label),
  ],
);

export type GoldenCaseRow = typeof goldenCases.$inferSelect;
export type NewGoldenCaseRow = typeof goldenCases.$inferInsert;
