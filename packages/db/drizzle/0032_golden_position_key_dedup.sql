-- UCB A3.6 fix: dedup golden_cases by the ACTIVE position_key.
--
-- Bug (observed 2026-06-03): re-marking golden positions created DUPLICATE rows
-- instead of updating the existing one. Root cause: the repository upsert keys
-- on `position_key`, but the unique index from 0028 was partial
-- `WHERE position_key IS NOT NULL`. Any caller that omitted positionKey (the
-- ad-hoc bulk-marking scripts, the anomaly-promote path) stored NULL, which the
-- index does NOT cover → ON CONFLICT never matched → every POST inserted a new
-- row. The 33 active rows all ended up with NULL position_key.
--
-- Two-part fix (the app layer additionally now REQUIRES a non-null positionKey
-- on the create endpoint, so no future caller can silently store NULL again):
--
--   1. Backfill position_key for every ACTIVE row that is missing one, derived
--      from durable anchor fields so it is never null again:
--        key = walletId | chain | protocolId | anchor | supplySymbols
--      • anchor priority: derivation.tokenId (this is the UI's `lpTokenId`,
--        unique per V3/Velodrome NFT) → open_hash → position_id. The stored
--        `market_key` is DELIBERATELY NOT used as the anchor here: for these
--        script-authored rows it holds the SHARED pool/vault address (e.g. two
--        Uniswap-V3 positions in one pool, or the ETH+WBTC legs of one Fluid
--        vault, share it) and would collide distinct positions.
--      • supplySymbols: sorted/upper-cased from derivation.supplyTokens
--        (`sym` or `symbol`), else parsed from a "TOKEN0/TOKEN1" label, else ''.
--        COLLATE "C" reproduces the JS code-unit sort `positionKey()` uses.
--      Rows whose source data is too sparse to reconstruct the live key (no
--      tokenId/openHash/supply — e.g. the Fluid legs) fall back to position_id:
--      a UNIQUE but display-only key. They stop self-duplicating, but to attach
--      the precise live key (so the UI highlights them) re-mark them from the
--      position UI after this migration.
--
--   2. Gate the unique index on status='active', replacing the 0028 index, so a
--      soft-retired anchor never blocks re-creating an active one, and the
--      repository's ON CONFLICT (status='active') can update the active row.

UPDATE golden_cases gc
SET position_key =
      gc.wallet_id::text || '|' || gc.chain || '|' || gc.protocol_id || '|'
      || coalesce(
           nullif(gc.derivation ->> 'tokenId', ''),
           nullif(gc.open_hash, ''),
           gc.position_id
         )
      || '|'
      || coalesce(
           CASE
             WHEN jsonb_typeof(gc.derivation -> 'supplyTokens') = 'array' THEN (
               SELECT string_agg(s, '+' ORDER BY s COLLATE "C")
               FROM (
                 SELECT upper(coalesce(e ->> 'sym', e ->> 'symbol')) AS s
                 FROM jsonb_array_elements(gc.derivation -> 'supplyTokens') e
                 WHERE coalesce(e ->> 'sym', e ->> 'symbol') IS NOT NULL
               ) z
             )
             ELSE NULL
           END,
           (
             SELECT string_agg(upper(p), '+' ORDER BY upper(p) COLLATE "C")
             FROM regexp_split_to_table(substring(gc.label FROM '([^ ]+/[^ ]+)'), '/') p
             WHERE p <> ''
           ),
           ''
         )
WHERE gc.status = 'active' AND gc.position_key IS NULL;

-- Replace the 0028 partial index (WHERE position_key IS NOT NULL) with one
-- gated on the active lifecycle. After the backfill no active row is null, so
-- this enforces one golden anchor per (position_key) among active rows; retired
-- history rows are excluded and never block a re-mark.
DROP INDEX IF EXISTS golden_cases_position_key_uq;

CREATE UNIQUE INDEX IF NOT EXISTS golden_cases_active_position_key_uq
  ON golden_cases (position_key)
  WHERE status = 'active';
