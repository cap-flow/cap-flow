-- UCB D8: soft-delete / manual correction for chain operations.
--
-- Adds an `excluded` flag to chain_operation_annotations. When TRUE, the
-- UCB pipeline ignores this op entirely (not just for cost-basis purposes —
-- excluded from lots tracker, position tracker, asset rollup, realized PnL).
--
-- Use cases:
--   * User reviewed a "swap" that's actually noise / failed tx with stuck
--     state — exclude it from cost basis.
--   * Spam token airdrop showing in DeBank but user doesn't want it
--     counted as cost basis.
--   * Classifier mis-detected a chain reorg ghost as a real transfer.
--
-- Why a boolean rather than DELETE:
--   * Data lineage preserved (op still in chain_operations, just hidden
--     from UCB compute).
--   * Re-sync from upstream won't resurrect the op (annotation persists).
--   * Easy to undo (set excluded=false).

ALTER TABLE chain_operation_annotations
  ADD COLUMN excluded BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index optimizing "find all excluded ops for user" queries
-- without bloating the table for the common case (excluded=false).
CREATE INDEX chain_op_annotations_excluded_idx
  ON chain_operation_annotations (user_id)
  WHERE excluded = TRUE;
