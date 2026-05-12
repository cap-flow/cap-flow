import {
  bigint,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./users.js";

/**
 * Two-state link between a user and a Telegram chat:
 *   pending   — user clicked "connect Telegram", we issued a one-time code,
 *               but the bot hasn't seen `/start <code>` yet.
 *   linked    — bot received `/start`, recorded `chat_id`.
 *
 * Phase 7 ships the database + HTTP endpoints; the actual bot listener
 * (long-poll or webhook) connects in Phase 7b once we decide on hosting.
 * Until then `NotificationsService.sendTelegram(...)` is a no-op for users
 * whose link is still `pending` — the audit log still records the attempt.
 */
export const telegramLinkStatusEnum = pgEnum("telegram_link_status", [
  "pending",
  "linked",
  "revoked",
]);

export const telegramLinks = pgTable(
  "telegram_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 of the one-time `/start` code shown to the user once on issue. */
    startCodeHash: text("start_code_hash").notNull(),
    status: telegramLinkStatusEnum("status").notNull().default("pending"),
    /** Filled by the bot listener when `/start <code>` lands. */
    chatId: bigint("chat_id", { mode: "number" }),
    telegramUsername: text("telegram_username"),
    linkedAt: timestamp("linked_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("telegram_links_start_code_uq").on(table.startCodeHash),
    index("telegram_links_user_idx").on(table.userId),
    index("telegram_links_chat_idx").on(table.chatId),
  ]
);

export type TelegramLinkRow = typeof telegramLinks.$inferSelect;
export type NewTelegramLinkRow = typeof telegramLinks.$inferInsert;
