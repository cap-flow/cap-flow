-- UCB A3.6: stable, globally-unique position identity for golden cases.
--
-- The display id POS-NNN reshuffles on every recompute, so identity moves to
-- `position_key` = walletId|chain|protocolId|(marketKey|openHash)|supplySymbols
-- (see @cap-flow/ucb positionKey). It is unique across ALL users (walletId is a
-- global UUID linked to one account). The old (wallet_id, position_id) unique
-- is dropped — position_id stays only as a human display label.

ALTER TABLE golden_cases ADD COLUMN IF NOT EXISTS position_key TEXT;

DROP INDEX IF EXISTS golden_cases_wallet_position_uq;

-- Partial unique: enforced for rows that have a key (legacy rows = null).
CREATE UNIQUE INDEX IF NOT EXISTS golden_cases_position_key_uq
  ON golden_cases (position_key)
  WHERE position_key IS NOT NULL;
