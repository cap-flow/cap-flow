import {
  boolean,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./users.js";

/**
 * Per-user, per-channel subscriptions to notification types.
 *
 * `type` is open text on purpose — new alert kinds appear without a schema
 * migration (e.g. `portfolio_change_5pct`, `refresh_failed`,
 * `aave_hf_below_threshold`). The frontend gets the list of available types
 * from a separate constants module so the dropdown stays consistent with
 * what the worker actually emits.
 */
export const notificationChannelEnum = pgEnum("notification_channel", [
  "email",
  "telegram",
]);

export const notificationSubscriptions = pgTable(
  "notification_subscriptions",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    channel: notificationChannelEnum("channel").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.type, table.channel] }),
    index("notification_subs_user_idx").on(table.userId),
  ]
);

export type NotificationSubscriptionRow =
  typeof notificationSubscriptions.$inferSelect;
export type NewNotificationSubscriptionRow =
  typeof notificationSubscriptions.$inferInsert;
