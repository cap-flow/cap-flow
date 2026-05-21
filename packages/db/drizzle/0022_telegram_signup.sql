-- Telegram-signup auth flow (2026-05-21).
--
-- Расширяет users + добавляет таблицу одноразовых nonce'ов для
-- регистрации/входа через Telegram бота `defiCapflow_bot`.
--
-- Flow:
--   1. Anonymous visitor → POST /v1/auth/telegram/start-signup
--      → server создаёт строку в telegram_signup_nonces с TTL 10 мин.
--   2. Browser открывает t.me/<bot>?start=s_<nonce>.
--   3. Bot poller / webhook ловит /start, парсит nonce, привязывает
--      Telegram user-id к этой строке (через user_id, который либо
--      найден по users.telegram_id, либо создан с status=pending,
--      password_hash=NULL).
--   4. Бот отвечает пользователю ссылкой
--      https://cap-flow.ru/login/finish?nonce=<...> — она one-shot.
--   5. Сервер на /finish помечает consumed_at, выдаёт session+access
--      cookies. Если у юзера ещё нет password_hash — redirect
--      /auth/set-password, иначе /.
--
-- One-shot: повторный GET /finish с тем же nonce → 410 Gone.
--
-- Безопасность: токен в чате имеет тот же риск как email-magic-link
-- (кто увидел — залогинился). TTL 10 мин + one-shot минимизируют
-- окно. Если канал утечёт — atomic UPDATE consumed_at IS NULL даст
-- консистентность.

-- Username field на users — для логина по нику (Phase 2: extend login
-- to accept email OR username). Сейчас храним telegramUsername как
-- preset; user может изменить на set-password page. UNIQUE NULLABLE —
-- старые email-only юзеры остаются с username=NULL.
ALTER TABLE users ADD COLUMN username TEXT;
CREATE UNIQUE INDEX users_username_uq ON users (username) WHERE username IS NOT NULL;

CREATE TABLE telegram_signup_nonces (
  -- SHA-256 от raw nonce (hex). Сам nonce НЕ хранится — выдаётся
  -- разово на /start-signup и приходит обратно через бота.
  nonce_hash TEXT PRIMARY KEY,

  -- NULL до момента, когда бот привязал Telegram identity. После
  -- /start-signup → /start-в-боте: либо найден существующий user
  -- по telegram_id, либо создан новый shell (status=pending,
  -- password_hash NULL).
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,

  -- Telegram identity, заполняется ботом из msg.from.* — диагностика
  -- и audit. user_id уже несёт реальную привязку.
  telegram_user_id BIGINT,
  telegram_chat_id BIGINT,
  telegram_username TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  -- Помечается на первом GET /finish — second call → 410 Gone.
  consumed_at TIMESTAMPTZ
);

CREATE INDEX telegram_signup_nonces_user_idx
  ON telegram_signup_nonces (user_id) WHERE user_id IS NOT NULL;

CREATE INDEX telegram_signup_nonces_expires_idx
  ON telegram_signup_nonces (expires_at);
