-- UCB B1: deterministic per-operation historical price cache (shared, global,
-- no user_id). Anchors price to the OBJECTIVE fact (DefiLlama coin + hour
-- bucket) so cost basis is identical regardless of which account/sync produced
-- the op. Fixes the non-determinism measured 2026-05-31 (movement.usd priced at
-- sync time → same tx differently valued across wallets/accounts, up to 25.9%).
--
-- Keyed by `coin` (= defillamaCoinKey) + `hour_bucket` (= floor(opTime/3600)*3600
-- epoch seconds) → served map key `${coin}|${hour_bucket}` matches the client
-- `cacheKeyFor()` histPrices Map byte-for-byte.
--
-- Additive only. R1: keyed by coin (never bare symbol) → no collision with
-- historical_prices(symbol,date) FX. R5: rows exist only for successful lookups.

CREATE TABLE IF NOT EXISTS op_token_prices (
  coin         text NOT NULL,                 -- defillamaCoinKey: 'ethereum:0x..' | 'coingecko:euro-coin' | ..
  hour_bucket  bigint NOT NULL,               -- floor(opTime/3600)*3600 (epoch seconds)
  price_usd    numeric(28,8) NOT NULL,
  priced_ok    boolean NOT NULL DEFAULT true,  -- R5 outage guard (rows only when true)
  chain        text NOT NULL,                  -- descriptive (not PK)
  token_id     text,                           -- descriptive: contract addr / native sentinel
  source       text NOT NULL,                  -- 'defillama' | 'op_raw'
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (coin, hour_bucket)
);

CREATE INDEX IF NOT EXISTS op_token_prices_bucket_idx ON op_token_prices (hour_bucket);
