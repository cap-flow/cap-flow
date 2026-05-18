-- 2026-05-14: CEX exchange API connections.
-- Idempotent.

CREATE TABLE IF NOT EXISTS public.cex_accounts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  account_id           uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  exchange             text NOT NULL,
  label                text,
  api_key_enc          text NOT NULL,
  api_secret_enc       text NOT NULL,
  api_passphrase_enc   text,
  permissions          jsonb,
  last_synced_at       timestamptz,
  last_sync_error      text,
  archived_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cex_accounts_user_idx ON public.cex_accounts (user_id);
CREATE INDEX IF NOT EXISTS cex_accounts_account_idx ON public.cex_accounts (account_id);

CREATE TABLE IF NOT EXISTS public.cex_balances (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cex_account_id  uuid NOT NULL REFERENCES public.cex_accounts(id) ON DELETE CASCADE,
  asset           text NOT NULL,
  account_type    text NOT NULL DEFAULT 'spot',
  free            numeric(28, 8) NOT NULL DEFAULT 0,
  used            numeric(28, 8) NOT NULL DEFAULT 0,
  total           numeric(28, 8) NOT NULL DEFAULT 0,
  price_usd       numeric(28, 8),
  snapshot_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cex_balances_account_snapshot_idx
  ON public.cex_balances (cex_account_id, snapshot_at);

CREATE TABLE IF NOT EXISTS public.cex_trades (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cex_account_id      uuid NOT NULL REFERENCES public.cex_accounts(id) ON DELETE CASCADE,
  exchange_trade_id   text NOT NULL,
  symbol              text NOT NULL,
  side                text NOT NULL,
  amount              numeric(28, 8) NOT NULL,
  price               numeric(28, 8) NOT NULL,
  cost                numeric(28, 8) NOT NULL,
  fee_currency        text,
  fee_amount          numeric(28, 8),
  taker               text,
  executed_at         timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS cex_trades_account_tradeid_uq
  ON public.cex_trades (cex_account_id, exchange_trade_id);
CREATE INDEX IF NOT EXISTS cex_trades_account_time_idx
  ON public.cex_trades (cex_account_id, executed_at);
