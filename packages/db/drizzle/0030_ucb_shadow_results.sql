-- UCB B5: server-computed canonical positions, SHADOW sink (account-scoped,
-- row-level isolation via account_id FK + ON DELETE CASCADE). Written by the
-- refresh worker only when the `capflow.feature.ucbServerShadow` flag is ON;
-- NEVER served (the UI keeps recomputing client-side until the B6 flip). This is
-- the observability surface that proves server == client before any flip.
--
-- `diff_summary` is filled by the shadow-diff comparator when the browser POSTs
-- its own positions to /ucb/shadow-diff (divergentCount + per-position deltas).
-- `lot_methodology` is persisted because cost basis depends on it (a shadow
-- result is only comparable to a client computed under the SAME mode).
-- `error` + empty `positions` records a fail-soft shadow compute.
--
-- Additive only.

CREATE TABLE IF NOT EXISTS ucb_shadow_results (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  trigger         text NOT NULL,                       -- 'refresh' | 'manual' | 'shadow_diff'
  lot_methodology text NOT NULL DEFAULT 'FIFO',        -- FIFO | LIFO | WAC | HIFO
  position_count  integer NOT NULL,
  positions       jsonb NOT NULL,                      -- server OpenPosition[] post-override
  engine_version  text NOT NULL,                       -- @cap-flow/ucb pkg version + git sha
  diff_summary    jsonb,                               -- ShadowDiffSummary; null until shadow-diff runs
  error           text                                 -- fail-soft: set when the compute threw
);

CREATE INDEX IF NOT EXISTS ucb_shadow_results_account_computed_idx
  ON ucb_shadow_results (account_id, computed_at DESC);
