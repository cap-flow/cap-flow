import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./users.js";

/**
 * One-shot tokens — password reset, magic-link login, email verification.
 *
 * Distinct from `invites` (which create new accounts) and `sessions` (which
 * are long-lived refresh-equivalent tokens for already-authenticated users).
 *
 * Existing table — we inherit it as-is.
 */
export const authTokens = pgTable(
  "auth_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * Token kind discriminator. `password_reset` (legacy default — pre-B4
     * rows are tagged automatically by migration) vs `email_verification`
     * (B4) vs future magic-link login. Services scope queries by purpose
     * so a password-reset token can't be replayed as an email-verify
     * one, and vice versa.
     */
    purpose: text("purpose").notNull().default("password_reset"),
    /**
     * Snapshot of the user's email at token issue time. Used by
     * email-verification so a token bound to alice@old.com is invalid
     * after she changes her primary email to alice@new.com. NULL for
     * legacy password-reset rows (the email is taken from `users` at
     * confirm time).
     */
    emailAtIssue: text("email_at_issue"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("auth_tokens_token_hash_unique").on(table.tokenHash),
    index("auth_tokens_user_idx").on(table.userId),
    index("auth_tokens_expires_idx").on(table.expiresAt),
    index("auth_tokens_purpose_idx").on(table.purpose),
  ]
);

export type AuthToken = typeof authTokens.$inferSelect;
export type NewAuthToken = typeof authTokens.$inferInsert;
