-- Phase 0: SaaS auth foundations.
--
-- Authored by hand (not generated) because the schema is being layered onto
-- a pre-existing database introspected via pg_dump. drizzle-kit's diff against
-- the partial TS schema would propose destructive drops; this file is the
-- safe equivalent.
--
-- Idempotent: every statement uses IF NOT EXISTS / IF EXISTS so re-running is
-- a no-op.

-- ───────────────────────────── users ─────────────────────────────
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

-- legacy_id and telegram_id used to be NOT NULL — relax for new users.
ALTER TABLE public.users ALTER COLUMN telegram_id DROP NOT NULL;
ALTER TABLE public.users ALTER COLUMN legacy_id DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_uq ON public.users (email);
CREATE INDEX IF NOT EXISTS users_role_idx ON public.users (role);
CREATE INDEX IF NOT EXISTS users_status_idx ON public.users (status);

-- ───────────────────────────── accounts ─────────────────────────────
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false;
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- legacy_id no longer required for accounts created via SaaS flow.
ALTER TABLE public.accounts ALTER COLUMN legacy_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS accounts_active_idx
  ON public.accounts (owner_id, archived_at);

-- ───────────────────────────── sessions ─────────────────────────────
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS last_used_at timestamptz NOT NULL DEFAULT now();

-- ───────────────────────────── invites ─────────────────────────────
DO $$ BEGIN
  CREATE TYPE public.invite_status AS ENUM ('pending', 'consumed', 'revoked', 'expired');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.invites (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               varchar(320) NOT NULL,
  token_hash          text NOT NULL,
  status              public.invite_status NOT NULL DEFAULT 'pending',
  created_by_user_id  uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  consumed_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  consumed_at         timestamptz,
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS invites_token_hash_uq
  ON public.invites (token_hash);
CREATE INDEX IF NOT EXISTS invites_email_idx ON public.invites (email);
CREATE INDEX IF NOT EXISTS invites_status_idx ON public.invites (status);
CREATE INDEX IF NOT EXISTS invites_expires_idx ON public.invites (expires_at);

-- ───────────────────────────── api_usage ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.api_usage (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid REFERENCES public.users(id) ON DELETE SET NULL,
  account_id        uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  provider          varchar(40) NOT NULL,
  endpoint          varchar(200) NOT NULL,
  http_status       integer,
  duration_ms       integer,
  cache_hit         integer NOT NULL DEFAULT 0,
  cost_estimate_usd numeric(12, 6),
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_usage_user_id_idx ON public.api_usage (user_id);
CREATE INDEX IF NOT EXISTS api_usage_provider_idx ON public.api_usage (provider);
CREATE INDEX IF NOT EXISTS api_usage_created_idx ON public.api_usage (created_at);
CREATE INDEX IF NOT EXISTS api_usage_provider_time_idx
  ON public.api_usage (provider, created_at);
