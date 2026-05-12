-- Phase 2: global reference data + per-account overrides + audit_log additions.
--
-- Idempotent. Existing per-account legacy tables (networks, custom_cg_ids,
-- token_prices) are NOT dropped here — that's a follow-up migration once
-- code stops touching them.

-- ─────────────────────────── audit_log additions ───────────────────────────
ALTER TABLE public.audit_log
  ADD COLUMN IF NOT EXISTS as_admin boolean NOT NULL DEFAULT false;
ALTER TABLE public.audit_log
  ADD COLUMN IF NOT EXISTS target_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.audit_log
  ADD COLUMN IF NOT EXISTS ip varchar(45);
ALTER TABLE public.audit_log
  ADD COLUMN IF NOT EXISTS user_agent text;

CREATE INDEX IF NOT EXISTS audit_log_target_user_idx
  ON public.audit_log (target_user_id);
CREATE INDEX IF NOT EXISTS audit_log_action_idx
  ON public.audit_log (action);

-- ─────────────────────────── chain_registry (global) ───────────────────────
CREATE TABLE IF NOT EXISTS public.chain_registry (
  chain_id            integer PRIMARY KEY,
  name                text NOT NULL,
  fee_token           text NOT NULL,
  enabled             boolean NOT NULL DEFAULT true,
  coingecko_platform  text,
  default_rpc_hint    text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chain_registry_enabled_idx
  ON public.chain_registry (enabled);

-- ─────────────────────────── coingecko_registry (global) ───────────────────
CREATE TABLE IF NOT EXISTS public.coingecko_registry (
  symbol              text PRIMARY KEY,
  coingecko_id        text NOT NULL,
  name                text,
  contract_addresses  jsonb NOT NULL DEFAULT '{}'::jsonb,
  priority            text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS coingecko_registry_coingecko_id_idx
  ON public.coingecko_registry (coingecko_id);
CREATE INDEX IF NOT EXISTS coingecko_registry_name_idx
  ON public.coingecko_registry (name);

-- ─────────────────────────── historical_prices (global) ────────────────────
CREATE TABLE IF NOT EXISTS public.historical_prices (
  symbol      text NOT NULL,
  date        date NOT NULL,
  price_usd   numeric(28, 8) NOT NULL,
  source      text NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, date)
);

CREATE INDEX IF NOT EXISTS historical_prices_date_idx
  ON public.historical_prices (date);

-- ─────────────────────────── cg_id_overrides (per-account) ─────────────────
CREATE TABLE IF NOT EXISTS public.cg_id_overrides (
  account_id    uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  symbol        text NOT NULL,
  coingecko_id  text NOT NULL,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, symbol)
);

CREATE INDEX IF NOT EXISTS cg_id_overrides_account_idx
  ON public.cg_id_overrides (account_id);
