-- 2026-05-14: track where the fiat-leg data came from on P2P orders.
--
-- The retail Bitget tax endpoint only returns the crypto leg. Fiat
-- currency/amount/price/counterparty/payment-method are supplied
-- after-the-fact by the user (manual dialog) or imported from a CSV
-- export Bitget's UI offers. We need to know which source filled the
-- row so:
--   - "api" stays null on fiat fields (those columns are nullable)
--   - "manual"   = user typed it in
--   - "csv"      = bulk-imported from a Bitget CSV export
--   - "merchant" = future Bitget merchant API (not implemented yet)
--
-- Knowing the source matters for cost-basis trust: manual entries may
-- be approximations, CSV is authoritative for past trades, merchant
-- is authoritative live. Defaults to 'api' for existing rows.

ALTER TABLE public.cex_p2p_orders
  ADD COLUMN IF NOT EXISTS fiat_source text NOT NULL DEFAULT 'api';
