-- UCB A3: per-op user annotations to override classifier decisions.
--
-- Why a separate table (vs jsonb column on chain_operations):
--   - chain_operations.raw is rewritten on each sync (classifier may update);
--     annotations must survive re-classification.
--   - Decouples user intent from machine derivation — clear audit trail.
--   - Supports future shared/team annotations (per-user FK).
--
-- Fields are deliberately narrow — A3 scope is overrides:
--   * is_internal_transfer: force/disable internal-transfer detection
--   * manual_cost_basis_usd: override classifier's startUsd / costBasis
--   * manual_op_type: re-classify (e.g. mistakenly-labeled swap → transfer)
--   * note: free-text annotation visible in UI

CREATE TABLE chain_operation_annotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_op_id UUID NOT NULL REFERENCES chain_operations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  is_internal_transfer BOOLEAN,
  manual_cost_basis_usd NUMERIC(20, 6),
  manual_op_type TEXT,
  note TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One annotation per (op, user). User updates re-write the row.
CREATE UNIQUE INDEX chain_op_annotations_op_user_uq
  ON chain_operation_annotations (chain_op_id, user_id);

-- Quick lookup by user for "all my annotations" panel.
CREATE INDEX chain_op_annotations_user_idx
  ON chain_operation_annotations (user_id);
