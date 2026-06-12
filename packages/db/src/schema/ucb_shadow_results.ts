import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { accounts } from "./accounts.js";

/**
 * UCB B5 — server-computed canonical positions, SHADOW sink (account-scoped).
 *
 * When the `capflow.feature.ucbServerShadow` flag is ON, the refresh worker
 * additionally runs the canonical `@cap-flow/ucb` engine server-side
 * (`ucb.service.ts::computePositions`) and writes the result here. It is NOT
 * served — the UI keeps recomputing client-side until B6 flips serving behind a
 * per-user flag with a permanent client-recompute fallback. This table is the
 * observability surface that proves server == client before any flip.
 *
 * `diff_summary` is filled by the shadow-diff comparator (`shadow-diff.ts`,
 * `ShadowDiffSummary`) when the browser POSTs its own computed positions to
 * `/ucb/shadow-diff`: it records `divergentCount` + per-position startUsd deltas.
 * The flip criterion: N consecutive refreshes with zero material diffs across
 * the top-K accounts INCLUDING every golden anchor.
 *
 * `lot_methodology` is persisted because cost basis depends on it (FIFO/LIFO/WAC)
 * — a shadow result is only comparable to a client computed under the SAME mode.
 * `error` makes the worker fail-soft: a row with `error` set + `positions=[]`
 * records that the shadow compute threw, without breaking the refresh.
 */
export const ucbShadowResults = pgTable(
  "ucb_shadow_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    computedAt: timestamp("computed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** What triggered the compute: 'refresh' | 'manual' | 'shadow_diff'. */
    trigger: text("trigger").notNull(),
    /** FIFO | LIFO | WAC | HIFO — the mode that produced `positions`. */
    lotMethodology: text("lot_methodology").notNull().default("FIFO"),
    positionCount: integer("position_count").notNull(),
    /** Server-computed OpenPosition[] post-override (the shadow result). */
    positions: jsonb("positions").notNull(),
    /** `@cap-flow/ucb` pkg version + git sha that produced `positions`. */
    engineVersion: text("engine_version").notNull(),
    /** ShadowDiffSummary from the comparator; null until a shadow-diff runs. */
    diffSummary: jsonb("diff_summary"),
    /** Fail-soft: non-null when the shadow compute errored (positions = []). */
    error: text("error"),
    /** StageRecord[] — per-stage trace конвейера (pipeline-trace.ts). */
    stages: jsonb("stages"),
  },
  (table) => [
    index("ucb_shadow_results_account_computed_idx").on(
      table.accountId,
      table.computedAt,
    ),
  ]
);

export type UcbShadowResultRow = typeof ucbShadowResults.$inferSelect;
export type NewUcbShadowResultRow = typeof ucbShadowResults.$inferInsert;
