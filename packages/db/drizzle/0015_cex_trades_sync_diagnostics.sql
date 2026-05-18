-- 2026-05-15: separate diagnostics for trade-history sync on CEX accounts.
--
-- Why a separate columns and not just `last_sync_error`:
--
-- `sync(account)` has two semi-independent phases — balance fetch and
-- trade-history fetch. Balance success is the gate (auth/network must
-- work), but trade-history success depends on a SEPARATE permission on
-- the API key. Today we glue both into one `last_sync_error` field, so
-- if trades fail (e.g. permission off) the overall sync is still
-- marked successful and the user sees a green card — they never learn
-- the real reason their cost basis is empty.
--
-- B1 (UCB data integrity) needs:
--   - `last_trades_sync_at`    — when we last successfully pulled trades
--     (null if never). UI shows "last trades: never / 3d ago".
--   - `last_trades_sync_error` — the explicit reason if the last attempt
--     failed (permission denied, timeout, requires symbol, etc.). UI
--     shows a yellow warning with actionable guidance.
--
-- Permissions JSONB itself gains 3 new keys via runtime updates (no
-- schema change there): `tradeHistory`, `deposits`, `withdrawals`
-- (PermStatus enum: 'ok'|'denied'|'unsupported'|'unknown') plus
-- `lastProbedAt`. JSONB is free-form so existing rows just get
-- additional keys; old code reading `permissions.read` keeps working.

ALTER TABLE public.cex_accounts
  ADD COLUMN IF NOT EXISTS last_trades_sync_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_trades_sync_error TEXT;
