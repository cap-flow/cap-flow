-- Phase 3: drop legacy per-account reference tables.
--
-- These were inherited from the prior schema and have been superseded by the
-- global registries created in Phase 2 plus Redis cache wired in Phase 3:
--   - `networks`      → `chain_registry` (global) + env-driven RPC keys.
--   - `custom_cg_ids` → `coingecko_registry` (global) + `cg_id_overrides` (per-account).
--   - `token_prices`  → Redis `price:{provider}:{symbol}` cache + `historical_prices`.
--
-- All three were empty per the Phase 0 inspection. This migration is
-- destructive of the *schema* but not of data.

DROP TABLE IF EXISTS public.token_prices;
DROP TABLE IF EXISTS public.custom_cg_ids;
DROP TABLE IF EXISTS public.networks;
