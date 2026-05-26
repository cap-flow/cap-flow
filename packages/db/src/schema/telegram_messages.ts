import {
  bigint,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./users.js";

/**
 * Хранение чата admin↔user через Telegram bot.
 *
 * direction='in'  — message от пользователя в bot (saved via webhook handler)
 * direction='out' — message от admin'а юзеру (saved when admin sends via UI)
 *
 * `telegramMsgId` — message_id из Telegram API (для possible reply/edit).
 * `readAt` — когда админ прочитал (для unread counter в UI).
 *
 * Attachments (file_url, file_type, file_name) для PR 3 — пока nullable
 * остаются, заполняются когда юзер шлёт фото/документ или админ attachment.
 */
export const telegramMessageDirectionEnum = pgEnum(
  "telegram_message_direction",
  ["in", "out"],
);

export const telegramMessageTypeEnum = pgEnum("telegram_message_type", [
  "text",
  "photo",
  "document",
  "audio",
  "video",
  "voice",
  "sticker",
  "other",
]);

export const telegramMessages = pgTable(
  "telegram_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** К какому юзеру относится conversation. */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    direction: telegramMessageDirectionEnum("direction").notNull(),
    /** Тип сообщения. По-умолчанию text. */
    type: telegramMessageTypeEnum("type").notNull().default("text"),
    /** Текст (caption для media, body для text). Nullable для pure media без caption. */
    text: text("text"),
    /** Telegram chat id, дублируется для query efficiency (избегаем JOIN на telegram_links). */
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    /** message_id от Telegram API (nullable если send failed before MsgId returned). */
    telegramMsgId: bigint("telegram_msg_id", { mode: "number" }),
    /** file_id / file_url для attachments (PR 3). */
    fileUrl: text("file_url"),
    fileName: text("file_name"),
    /** Когда админ прочитал (только для direction='in'). NULL = unread. */
    readAt: timestamp("read_at", { withTimezone: true }),
    /** Когда отправлено / получено. */
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("telegram_messages_user_created_idx").on(
      table.userId,
      table.createdAt,
    ),
    index("telegram_messages_unread_idx").on(table.userId, table.readAt),
  ],
);

export type TelegramMessageRow = typeof telegramMessages.$inferSelect;
export type NewTelegramMessageRow = typeof telegramMessages.$inferInsert;
