-- 2026-05-14: CEX deposit/withdrawal history.
--
-- Tracks crypto movements between a CEX account and external wallets:
--   - direction='deposit'    — funds CAME INTO the CEX from elsewhere
--   - direction='withdrawal' — funds LEFT the CEX to an external address
--
-- The `tx_hash` column is the on-chain transaction hash (CCXT calls it
-- "txid"). Pairing a CEX transfer with the matching on-chain operation
-- on a user's wallet is a hash-equality lookup — see the frontend
-- internal-CEX badge logic.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS public.cex_transfers (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cex_account_id         uuid NOT NULL REFERENCES public.cex_accounts(id) ON DELETE CASCADE,
  exchange_transfer_id   text NOT NULL,
  direction              text NOT NULL,                       -- 'deposit' | 'withdrawal'
  asset                  text NOT NULL,
  amount                 numeric(28, 8) NOT NULL,
  fee_amount             numeric(28, 8),
  fee_currency           text,
  network                text,                                -- 'eth' | 'arbitrum' | 'bsc' | 'tron' | ... (exchange-reported)
  address                text,                                -- counterparty address (where it came from / went to)
  tx_hash                text,                                -- on-chain hash; NULL for legacy / queued / failed transfers
  status                 text NOT NULL,                       -- 'ok' | 'pending' | 'failed' | 'canceled' | ...
  executed_at            timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS cex_transfers_account_tid_uq
  ON public.cex_transfers (cex_account_id, exchange_transfer_id);
CREATE INDEX IF NOT EXISTS cex_transfers_account_time_idx
  ON public.cex_transfers (cex_account_id, executed_at);
CREATE INDEX IF NOT EXISTS cex_transfers_tx_hash_idx
  ON public.cex_transfers (tx_hash) WHERE tx_hash IS NOT NULL;
