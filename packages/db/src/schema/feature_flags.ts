import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/** Existing enum: per-scope flags (global / per-account / per-user). */
export const featureFlagScopeEnum = pgEnum("feature_flag_scope", [
  "global",
  "account",
  "user",
]);

/**
 * Feature flags with per-scope targeting.
 *
 *   scope = global  → scope_ref_id NULL, applies to everyone
 *   scope = account → scope_ref_id = account.id
 *   scope = user    → scope_ref_id = user.id
 *
 * Lookup at runtime: pick the most specific row for the (key, user, account)
 * tuple, fall back to global. Lets the canary rollout described in Phase 6
 * be expressed as "global=false + per-user enabled rows for the cohort".
 */
export const featureFlags = pgTable(
  "feature_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    scope: featureFlagScopeEnum("scope").notNull(),
    scopeRefId: uuid("scope_ref_id"),
    enabled: boolean("enabled").notNull().default(false),
    payload: jsonb("payload"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("feature_flags_key_scope_idx").on(
      table.key,
      table.scope,
      table.scopeRefId
    ),
  ]
);

export type FeatureFlag = typeof featureFlags.$inferSelect;
export type NewFeatureFlag = typeof featureFlags.$inferInsert;
