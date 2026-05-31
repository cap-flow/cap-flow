-- UCB A3.6: store the DERIVATION (knowledge base) for a golden case — the
-- on-chain operations that feed the position + the cost-flow that yields the
-- number. Single source of truth = blockchain ops (chain_operations); this
-- records WHY a number is correct so the engine/detector can enforce the
-- pattern on similar positions. Additive jsonb.

ALTER TABLE golden_cases
  ADD COLUMN IF NOT EXISTS derivation JSONB;
