-- B4 (2026-05-14): split auth_tokens by purpose so email-verification
-- and password-reset tokens cannot be replayed against each other.
-- Idempotent.

ALTER TABLE public.auth_tokens
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'password_reset';

ALTER TABLE public.auth_tokens
  ADD COLUMN IF NOT EXISTS email_at_issue text;

CREATE INDEX IF NOT EXISTS auth_tokens_purpose_idx
  ON public.auth_tokens (purpose);
