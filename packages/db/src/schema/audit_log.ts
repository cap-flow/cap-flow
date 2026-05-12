import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { accounts } from "./accounts.js";
import { users } from "./users.js";

/**
 * Audit log — every privileged action lands here.
 *
 * Pre-existing columns: actor_id, account_id, action, target, payload,
 * occurred_at, created_at.
 *
 * Phase 2 additions: as_admin, target_user_id, ip, user_agent — needed so we
 * can distinguish actions taken by an admin while impersonating a user from
 * the user's own actions, and so we can answer "show every action that
 * touched user X" without grepping JSON payloads.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** True when the actor was an admin impersonating someone. */
    asAdmin: boolean("as_admin").notNull().default(false),
    /** When acting on/for another user — that user's id. */
    targetUserId: uuid("target_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    accountId: uuid("account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    target: text("target"),
    payload: jsonb("payload"),
    ip: varchar("ip", { length: 45 }),
    userAgent: text("user_agent"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("audit_log_actor_idx").on(table.actorId),
    index("audit_log_target_user_idx").on(table.targetUserId),
    index("audit_log_action_idx").on(table.action),
    index("audit_log_occurred_idx").on(table.occurredAt),
  ]
);

export type AuditEntry = typeof auditLog.$inferSelect;
export type NewAuditEntry = typeof auditLog.$inferInsert;
