-- Phase 8: crypto billing — receive addresses + observed transactions.
-- Idempotent. user_payments already has payment_method (Phase 0).

-- ─────────────────────────── crypto_payment_addresses ─────────────────
DO $$ BEGIN
  CREATE TYPE public.crypto_network AS ENUM ('trc20', 'erc20');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.crypto_payment_addresses (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  network            public.crypto_network NOT NULL,
  address            text NOT NULL,
  derivation_index   integer,
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS crypto_payment_addresses_net_addr_uq
  ON public.crypto_payment_addresses (network, address);
CREATE INDEX IF NOT EXISTS crypto_payment_addresses_user_idx
  ON public.crypto_payment_addresses (user_id);
CREATE INDEX IF NOT EXISTS crypto_payment_addresses_active_idx
  ON public.crypto_payment_addresses (active);

-- ─────────────────────────── payment_transactions ─────────────────────
CREATE TABLE IF NOT EXISTS public.payment_transactions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address_id            uuid NOT NULL REFERENCES public.crypto_payment_addresses(id) ON DELETE CASCADE,
  network               public.crypto_network NOT NULL,
  tx_hash               text NOT NULL,
  from_address          text,
  amount                numeric(28, 8) NOT NULL,
  confirmations         integer NOT NULL DEFAULT 0,
  observed_at           timestamptz NOT NULL DEFAULT now(),
  credited_payment_id   uuid REFERENCES public.user_payments(id) ON DELETE SET NULL,
  note                  text
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_transactions_net_hash_uq
  ON public.payment_transactions (network, tx_hash);
CREATE INDEX IF NOT EXISTS payment_transactions_address_idx
  ON public.payment_transactions (address_id);
CREATE INDEX IF NOT EXISTS payment_transactions_observed_idx
  ON public.payment_transactions (observed_at);
