-- Pipeline observability: per-stage trace (status/ms/metrics/warnings) рядом с
-- результатом расчёта. Источник: apps/api/src/modules/ucb/pipeline-trace.ts.
ALTER TABLE ucb_shadow_results
  ADD COLUMN IF NOT EXISTS stages JSONB;
