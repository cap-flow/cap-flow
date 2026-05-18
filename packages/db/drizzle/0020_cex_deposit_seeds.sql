-- UCB C1: client-supplied cost basis seeds for CEX deposits.
--
-- Когда user withdraw'ит crypto on-chain → CEX, server-side
-- `CexCostBasisService.applyDeposit` сейчас ставит cost=$0 (non-stable)
-- или amount (stable). Это разрывает UCB chain: реальная cost basis
-- (что user реально заплатил за вывод) теряется.
--
-- Решение: client (имеющий полный orchestrator + lot tracker) считает
-- cost basis для каждого transfer_out → CEX и POSTs seeds сюда. Server
-- читает их в applyDeposit и использует вместо default'ов.
--
-- Per-user unique by tx_hash — повторный POST с тем же hash обновляет
-- запись (idempotent через ON CONFLICT).

CREATE TABLE cex_deposit_seeds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Canonical lowercase tx hash on the origin chain (EVM 0x...,
  -- Solana base58 — sign-preserving).
  tx_hash TEXT NOT NULL,
  -- Origin chain identifier (eth / arb / base / sol / ...).
  chain TEXT NOT NULL,

  -- Computed cost basis USD. ALWAYS non-negative.
  cost_basis_usd NUMERIC(20, 6) NOT NULL,

  -- Source wallet (для UI provenance + при wallet deletion seed сохраняется,
  -- просто wallet_id становится NULL).
  wallet_id UUID REFERENCES wallets(id) ON DELETE SET NULL,

  -- Free-text annotation (e.g. "manual override after audit").
  note TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX cex_deposit_seeds_user_hash_uq
  ON cex_deposit_seeds (user_id, tx_hash);

-- Index для быстрого "give me all seeds for txHash batch" в applyDeposit.
CREATE INDEX cex_deposit_seeds_user_idx
  ON cex_deposit_seeds (user_id);
