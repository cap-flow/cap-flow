-- Phase S6 (2026-05-14): admin-editable upstream API key overrides.
-- DB row overrides env var of the same key; empty value falls back to env.
-- Idempotent.

CREATE TABLE IF NOT EXISTS public.integration_secrets (
  key           text PRIMARY KEY,
  env_var_name  text NOT NULL,
  value         text,
  updated_by    uuid REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS integration_secrets_updated_at_idx
  ON public.integration_secrets (updated_at DESC);
