-- UCB B3: CEX internal transfers (Spot ↔ Funding ↔ Earn ↔ Sub-account).
--
-- Зачем отдельной таблицей от `cex_transfers`:
--   - `cex_transfers` хранит ВНЕШНИЕ deposits/withdrawals (on-chain hash,
--     network, address). У internal'ов этих полей нет.
--   - Internal transfer = два account-types вместо address: from_account,
--     to_account (spot / funding / earn / sub-<name>).
--   - CCXT возвращает их через `fetchTransfers`, не `fetchDeposits/
--     fetchWithdrawals`.
--
-- Нужен для UCB: без этой таблицы перевод USDT spot→earn виден как gap в
-- наших cex balance calc (мы видим withdrawal с spot, но не приход на earn,
-- т.е. деньги "исчезают" из нашей картины пока не вернутся).
--
-- Idempotent через unique (cex_account_id, exchange_transfer_id).

CREATE TABLE cex_internal_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cex_account_id UUID NOT NULL REFERENCES cex_accounts(id) ON DELETE CASCADE,
  exchange_transfer_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  amount NUMERIC(36, 18) NOT NULL,
  from_account TEXT NOT NULL,
  to_account TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  executed_at TIMESTAMPTZ NOT NULL,
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX cex_internal_transfers_account_id_uq
  ON cex_internal_transfers (cex_account_id, exchange_transfer_id);
CREATE INDEX cex_internal_transfers_account_time_idx
  ON cex_internal_transfers (cex_account_id, executed_at DESC);

-- Sync state per account: last_internal_transfers_sync_at + error.
ALTER TABLE cex_accounts
  ADD COLUMN last_internal_transfers_sync_at TIMESTAMPTZ,
  ADD COLUMN last_internal_transfers_sync_error TEXT;
