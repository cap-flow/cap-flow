-- Phase 7: notifications — telegram link table + per-user subscriptions.
-- Idempotent.

-- ─────────────────────────── telegram_links ─────────────────────────
DO $$ BEGIN
  CREATE TYPE public.telegram_link_status AS ENUM ('pending', 'linked', 'revoked');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.telegram_links (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  start_code_hash    text NOT NULL,
  status             public.telegram_link_status NOT NULL DEFAULT 'pending',
  chat_id            bigint,
  telegram_username  text,
  linked_at          timestamptz,
  revoked_at         timestamptz,
  expires_at         timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS telegram_links_start_code_uq
  ON public.telegram_links (start_code_hash);
CREATE INDEX IF NOT EXISTS telegram_links_user_idx
  ON public.telegram_links (user_id);
CREATE INDEX IF NOT EXISTS telegram_links_chat_idx
  ON public.telegram_links (chat_id);

-- ─────────────────────────── notification_subscriptions ─────────────
DO $$ BEGIN
  CREATE TYPE public.notification_channel AS ENUM ('email', 'telegram');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.notification_subscriptions (
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  type        text NOT NULL,
  channel     public.notification_channel NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, type, channel)
);

CREATE INDEX IF NOT EXISTS notification_subs_user_idx
  ON public.notification_subscriptions (user_id);
