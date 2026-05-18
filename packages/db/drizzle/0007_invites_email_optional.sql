-- Phase S7 (2026-05-14): invite links are now email-less.
-- Admin generates a link → forwards manually to user → user enters their
-- own email + password at /invite/:token. The pre-bound email column
-- becomes optional (kept for backwards-compat with already-issued invites).

ALTER TABLE public.invites
  ALTER COLUMN email DROP NOT NULL;
