import {
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { accounts } from "./accounts.js";
import { users } from "./users.js";

/** Existing enum for the four-state workflow. */
export const editRequestStatusEnum = pgEnum("edit_request_status", [
  "pending",
  "approved",
  "denied",
  "cancelled",
  "expired",
]);

/**
 * Time-boxed admin-edit grants.
 *
 * When an admin needs to make changes inside a user's account, they file a
 * request that the user can approve. On approval the admin's session gets
 * `impersonation_mode = "edit"` until `edit_granted_until`. Inherited as-is.
 */
export const editRequests = pgTable(
  "edit_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    targetUserId: uuid("target_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    adminId: uuid("admin_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").references(() => accounts.id, {
      onDelete: "cascade",
    }),
    reason: text("reason"),
    status: editRequestStatusEnum("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    grantedUntil: timestamp("granted_until", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    deniedAt: timestamp("denied_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("edit_requests_target_idx").on(table.targetUserId),
    index("edit_requests_status_idx").on(table.status),
  ]
);

export type EditRequest = typeof editRequests.$inferSelect;
export type NewEditRequest = typeof editRequests.$inferInsert;
