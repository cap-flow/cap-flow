-- 2026-05-15: UCB B5.1 — server-side persistence для on-chain ops.
--
-- Сейчас on-chain ops (DeBank/Helius classified) живут только в browser
-- localStorage. Это означает:
--   - При login с другого device — пустой кэш, full DeBank pull (~$$)
--   - Нельзя background-refresh когда user offline (BullMQ worker)
--   - Cost basis recompute на каждый reload (тяжёлая работа на клиенте)
--
-- `chain_operations` хранит ops как-есть (JSON в `raw`) + индексированные
-- основные поля для query. Per `(wallet_id, tx_hash, log_index)` unique
-- — idempotent upsert при повторном sync.
--
-- Не путать с `operations` table — та для legacy manual-import fund-tracker
-- model (date, fromName, toName, etc.). `chain_operations` хранит сырые
-- DeBank/Helius events классификации Capflow-classifier'а.

CREATE TABLE IF NOT EXISTS public.chain_operations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id    UUID NOT NULL REFERENCES public.wallets(id) ON DELETE CASCADE,
  chain        TEXT NOT NULL,
  tx_hash      TEXT NOT NULL,
  log_index    INTEGER NOT NULL DEFAULT 0,
  op_type      TEXT NOT NULL,
  op_time      TIMESTAMPTZ NOT NULL,
  status       TEXT NOT NULL DEFAULT 'ok',
  /* Сырой ClassifiedOp как пришёл от DeBank/Helius после classifier.
   * Frozen-shape contract с клиентом — никаких миграций при изменении
   * classifier-логики, при следующем sync raw перезапишется новой формой. */
  raw          JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent upsert key: один tx_hash может содержать несколько log_index
-- (multi-event tx — например swap + LP add в одной транзакции).
CREATE UNIQUE INDEX IF NOT EXISTS chain_operations_wallet_tx_log_uq
  ON public.chain_operations (wallet_id, tx_hash, log_index);

-- Hot queries: list ops для wallet в обратной хронологии (newest first).
CREATE INDEX IF NOT EXISTS chain_operations_wallet_time_idx
  ON public.chain_operations (wallet_id, op_time DESC);

-- Cross-wallet lookups (UCB graph traversal): find transfer_in by hash
-- → matching transfer_out on another wallet. Используется в этапе A1.
CREATE INDEX IF NOT EXISTS chain_operations_hash_idx
  ON public.chain_operations (tx_hash);

-- Sync-state per wallet: когда мы last-synced from DeBank/Helius.
-- Используется в delta-refresh (only fetch ops since this time).
ALTER TABLE public.wallets
  ADD COLUMN IF NOT EXISTS last_ops_sync_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_ops_sync_error TEXT;
