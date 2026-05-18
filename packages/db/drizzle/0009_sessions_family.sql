-- H1 (2026-05-14): refresh-token family revocation for reuse detection.
-- Each refresh rotation copies family_id from parent; reuse of any
-- already-rotated token triggers revocation of the whole family.
-- Idempotent.

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS family_id uuid;

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS revoked_reason text;

-- Backfill: every existing session starts its own family (no chain yet).
UPDATE public.sessions
SET family_id = id
WHERE family_id IS NULL;

CREATE INDEX IF NOT EXISTS sessions_family_idx
  ON public.sessions (family_id);
