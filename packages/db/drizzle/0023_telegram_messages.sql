-- Admin↔user chat через Telegram-бот (2026-05-26).
--
-- Схема была добавлена в `packages/db/src/schema/telegram_messages.ts`
-- вместе с feat(admin chat) коммитами, но соответствующая SQL-миграция
-- не была закомичена, поэтому в проде таблицы нет и:
--   • GET /v1/admin/telegram-chat/unread → 500
--   • webhook на /v1/telegram/webhook ловит throw на INSERT и теряет
--     incoming messages (returns 200, не ретраит).
--
-- direction='in'  — message от пользователя в бот.
-- direction='out' — message от админа юзеру (через UI).
-- type='text' по умолчанию; для media (photo/document/voice/...) ставится
-- соответствующий тип и заполняется file_url/file_name (опционально).

DO $$ BEGIN
  CREATE TYPE telegram_message_direction AS ENUM ('in', 'out');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE telegram_message_type AS ENUM (
    'text', 'photo', 'document', 'audio', 'video', 'voice', 'sticker', 'other'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS telegram_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  direction       telegram_message_direction NOT NULL,
  type            telegram_message_type NOT NULL DEFAULT 'text',
  text            TEXT,
  chat_id         BIGINT NOT NULL,
  telegram_msg_id BIGINT,
  file_url        TEXT,
  file_name       TEXT,
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS telegram_messages_user_created_idx
  ON telegram_messages (user_id, created_at);

CREATE INDEX IF NOT EXISTS telegram_messages_unread_idx
  ON telegram_messages (user_id, read_at);
