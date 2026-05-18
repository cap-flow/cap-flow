-- 2026-05-14: CEX P2P (peer-to-peer / fiat) order history.
-- Idempotent.

CREATE TABLE IF NOT EXISTS public.cex_p2p_orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cex_account_id     uuid NOT NULL REFERENCES public.cex_accounts(id) ON DELETE CASCADE,
  exchange_order_id  text NOT NULL,
  side               text NOT NULL,                    -- 'buy' | 'sell' (user perspective)
  asset              text NOT NULL,                    -- crypto leg, e.g. USDT
  amount             numeric(28, 8) NOT NULL,          -- crypto amount
  fiat_currency      text NOT NULL,                    -- RUB / USD / EUR / VND / ...
  fiat_amount        numeric(28, 8) NOT NULL,          -- total fiat exchanged
  unit_price         numeric(28, 8) NOT NULL,          -- fiat per 1 crypto (denormalized — used in nearly every query)
  counterparty       text,                             -- counterparty handle / merchant name (may be redacted)
  payment_method     text,                             -- "Sberbank", "Tinkoff", "Binance Pay", ...
  status             text NOT NULL,                    -- 'completed' | 'appealed' | 'cancelled' | 'pending' (exchange-specific)
  executed_at        timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS cex_p2p_orders_account_orderid_uq
  ON public.cex_p2p_orders (cex_account_id, exchange_order_id);
CREATE INDEX IF NOT EXISTS cex_p2p_orders_account_time_idx
  ON public.cex_p2p_orders (cex_account_id, executed_at);
