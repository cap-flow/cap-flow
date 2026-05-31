-- UCB A3.5: distinguish "golden" (correct anchor) from "wrong" (flagged for
-- fix) golden_cases, and capture WHICH metric is wrong. Additive.
--
--   kind  : 'golden' = position computes correctly (expected = frozen current)
--           'wrong'  = position is incorrect / suspicious (drives a fix)
--   issue : for kind='wrong' — which parameter is off
--           ('start_usd' | 'fees' | 'apr' | 'pnl' | 'current_value' | 'other')

ALTER TABLE golden_cases
  ADD COLUMN IF NOT EXISTS kind  TEXT NOT NULL DEFAULT 'golden',
  ADD COLUMN IF NOT EXISTS issue TEXT;
