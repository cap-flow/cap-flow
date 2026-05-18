import {
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { users } from "./users.js";

/**
 * Invitation tokens — admin-issued, one-shot, email-bound.
 *
 * Workflow:
 *   1. Admin creates an invite for a target email; raw token is shown once
 *      and the SHA-256 hash is stored.
 *   2. Recipient opens /invite/{token}, sets password → user row is created
 *      and the invite is marked consumed.
 *
 * Distinct from `auth_tokens` (password reset / magic link for existing
 * users) and `sessions` (long-lived refresh tokens after auth).
 */
export const inviteStatusEnum = pgEnum("invite_status", [
  "pending",
  "consumed",
  "revoked",
  "expired",
]);

export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Email may be pre-bound by admin (legacy flow) or `null` for "open"
    // invite links where the user enters their email at /invite/:token.
    email: varchar("email", { length: 320 }),
    tokenHash: text("token_hash").notNull(),
    status: inviteStatusEnum("status").notNull().default("pending"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    consumedByUserId: uuid("consumed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("invites_token_hash_uq").on(table.tokenHash),
    index("invites_email_idx").on(table.email),
    index("invites_status_idx").on(table.status),
    index("invites_expires_idx").on(table.expiresAt),
  ]
);

export type Invite = typeof invites.$inferSelect;
export type NewInvite = typeof invites.$inferInsert;
