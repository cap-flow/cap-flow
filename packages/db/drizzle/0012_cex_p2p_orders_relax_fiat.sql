-- 2026-05-14: relax fiat fields to nullable on cex_p2p_orders.
--
-- Bitget retail API endpoint `/api/v2/tax/p2p-record` only returns the
-- crypto leg of a P2P trade (coin, balance, transfer-in/out, ts) — no
-- fiat currency, fiat amount or unit price are exposed to retail keys
-- (those live behind the merchant-only `/api/v2/p2p/orderList`). To
-- store retail P2P history at all we have to accept rows with these
-- fields unknown.

ALTER TABLE public.cex_p2p_orders ALTER COLUMN fiat_currency DROP NOT NULL;
ALTER TABLE public.cex_p2p_orders ALTER COLUMN fiat_amount   DROP NOT NULL;
ALTER TABLE public.cex_p2p_orders ALTER COLUMN unit_price    DROP NOT NULL;
