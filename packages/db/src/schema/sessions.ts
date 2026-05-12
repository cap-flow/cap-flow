import {
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./users.js";

/** Existing enum used by sessions for admin impersonation grants. */
export const impersonationModeEnum = pgEnum("impersonation_mode", [
  "view",
  "edit",
]);

/**
 * Sessions table.
 *
 * Stores long-lived refresh-equivalent tokens. Short-lived JWT access tokens
 * carry the session id (`sid` claim) and are validated against this row.
 *
 * Existing columns: session_token_hash (UNIQUE), user_agent, ip, expires_at,
 *   revoked_at, impersonated_by_id, impersonation_mode, edit_request_id,
 *   edit_granted_until.
 *
 * Phase 0 addition: last_used_at — refreshed on each /auth/refresh.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionTokenHash: text("session_token_hash").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    userAgent: text("user_agent"),
    ip: text("ip"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),

    // Admin impersonation linkage (existing).
    impersonatedById: uuid("impersonated_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    impersonationMode: impersonationModeEnum("impersonation_mode"),
    editRequestId: uuid("edit_request_id"),
    editGrantedUntil: timestamp("edit_granted_until", { withTimezone: true }),

    // Phase 0 addition.
    lastUsedAt: timestamp("last_used_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("sessions_session_token_hash_unique").on(
      table.sessionTokenHash
    ),
    index("sessions_user_idx").on(table.userId),
    index("sessions_expires_idx").on(table.expiresAt),
  ]
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
