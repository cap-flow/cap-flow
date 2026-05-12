import {
  bigint,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** Existing enum in DB. Includes "viewer" role inherited from prior schema. */
export const userRoleEnum = pgEnum("user_role", ["admin", "user", "viewer"]);

/** Existing enum: active/pending/blocked (NOT my earlier active/suspended/deleted). */
export const userStatusEnum = pgEnum("user_status", [
  "active",
  "pending",
  "blocked",
]);

/**
 * Users table.
 *
 * Pre-existing columns (kept for back-compat with prior Telegram-only auth):
 *   legacy_id, telegram_id (UNIQUE), telegram_username, first_name, last_name,
 *   role, status, notes, active_account_id, tracked_tickers, billing_meta.
 *
 * Phase 0 additions (email/password auth):
 *   email (UNIQUE), password_hash, name, email_verified_at, last_login_at.
 *
 * Migration step (separate): legacy_id + telegram_id become nullable so new
 * users created via invite-flow don't need them.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Legacy / Telegram-era fields (now nullable after migration).
    legacyId: text("legacy_id"),
    telegramId: bigint("telegram_id", { mode: "number" }),
    telegramUsername: text("telegram_username"),
    firstName: text("first_name"),
    lastName: text("last_name"),

    // Phase 0 additions (email/password).
    email: text("email"),
    passwordHash: text("password_hash"),
    name: text("name"),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),

    // Common fields.
    role: userRoleEnum("role").notNull().default("user"),
    status: userStatusEnum("status").notNull().default("active"),
    notes: text("notes"),
    activeAccountId: uuid("active_account_id"),
    trackedTickers: text("tracked_tickers")
      .array()
      .notNull()
      .default([]),
    billingMeta: jsonb("billing_meta"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("users_email_uq").on(table.email),
    uniqueIndex("users_telegram_id_uq").on(table.telegramId),
    uniqueIndex("users_legacy_id_unique").on(table.legacyId),
    index("users_role_idx").on(table.role),
    index("users_status_idx").on(table.status),
  ]
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
