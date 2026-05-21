import {
  bigint,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./users.js";

/**
 * One-shot nonce для регистрации/входа через Telegram бота
 * (см. migration 0022).
 *
 * Lifecycle:
 *   - `POST /v1/auth/telegram/start-signup` создаёт строку с
 *     `nonce_hash` = sha256(raw nonce), expires_at = now + 10min,
 *     user_id NULL.
 *   - Bot ловит `/start s_<raw nonce>`. Парсит, ищет / создаёт
 *     `users` запись по `telegram_id`, заполняет `user_id` + Telegram
 *     identity поля в этой nonce-строке.
 *   - Bot шлёт пользователю в чат one-shot ссылку
 *     `https://cap-flow.ru/login/finish?nonce=<raw>`.
 *   - Сервер на /finish атомарно `UPDATE ... SET consumed_at=now()
 *     WHERE nonce_hash=$1 AND consumed_at IS NULL AND expires_at > now()
 *     AND user_id IS NOT NULL`. Если строк изменено 0 → 410 Gone.
 *     Иначе → issue session+access cookies на user_id, 302 на
 *     `/auth/set-password` (если password_hash NULL) или `/`.
 */
export const telegramSignupNonces = pgTable(
  "telegram_signup_nonces",
  {
    nonceHash: text("nonce_hash").primaryKey(),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    telegramUserId: bigint("telegram_user_id", { mode: "number" }),
    telegramChatId: bigint("telegram_chat_id", { mode: "number" }),
    telegramUsername: text("telegram_username"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [
    index("telegram_signup_nonces_user_idx").on(table.userId),
    index("telegram_signup_nonces_expires_idx").on(table.expiresAt),
  ],
);

export type TelegramSignupNonceRow =
  typeof telegramSignupNonces.$inferSelect;
export type NewTelegramSignupNonceRow =
  typeof telegramSignupNonces.$inferInsert;
