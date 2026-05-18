-- UCB B4: CEX ledger — master record всех balance-affecting entries.
--
-- В отличие от cex_trades (только trades), cex_transfers (deposits/
-- withdrawals on-chain), cex_p2p_orders (P2P), cex_internal_transfers
-- (sub-account moves) — `cex_ledger` хранит ВСЕ движения:
--   - trade fills (spot/futures)
--   - deposits + withdrawals
--   - internal transfers
--   - fees (как отдельные entries)
--   - rebates / cashback
--   - interest (savings, lending products)
--   - staking rewards / earn yields
--   - funding rates (perp)
--
-- Зачем дублировать с trades/transfers:
--   - fetchLedger возвращает MORE comprehensive data
--   - some income types (staking interest, fee rebates) НЕТ в trades
--   - используем как cross-check для других sync sources
--   - long-term: может заменить отдельные trade/transfer syncs
--
-- Idempotent через unique (cex_account_id, exchange_entry_id).

CREATE TABLE cex_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cex_account_id UUID NOT NULL REFERENCES cex_accounts(id) ON DELETE CASCADE,
  exchange_entry_id TEXT NOT NULL,
  account TEXT,
  asset TEXT NOT NULL,
  amount NUMERIC(36, 18) NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  type TEXT NOT NULL CHECK (
    type IN ('trade', 'deposit', 'withdrawal', 'transfer', 'fee',
             'rebate', 'interest', 'staking', 'funding', 'other')
  ),
  reference_id TEXT,
  fee_amount NUMERIC(36, 18),
  fee_currency TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  executed_at TIMESTAMPTZ NOT NULL,
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX cex_ledger_account_id_uq
  ON cex_ledger (cex_account_id, exchange_entry_id);

CREATE INDEX cex_ledger_account_time_idx
  ON cex_ledger (cex_account_id, executed_at DESC);

CREATE INDEX cex_ledger_account_asset_type_idx
  ON cex_ledger (cex_account_id, asset, type);

COMMENT ON TABLE cex_ledger IS
  'UCB B4: master record всех CEX balance-affecting entries. Comprehensive stream через fetchLedger CCXT method.';

-- UCB B4: ledger sync diagnostics на cex_accounts
ALTER TABLE cex_accounts
  ADD COLUMN IF NOT EXISTS last_ledger_sync_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_ledger_sync_error TEXT;

COMMENT ON COLUMN cex_accounts.last_ledger_sync_at IS
  'UCB B4: timestamp последнего успешного fetchLedger sync.';
COMMENT ON COLUMN cex_accounts.last_ledger_sync_error IS
  'UCB B4: error от последнего fetchLedger попытки (NULL если ok).';
