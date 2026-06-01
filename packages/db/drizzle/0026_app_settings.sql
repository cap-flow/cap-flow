-- Admin-tunable app settings (key-value), 2026-06.
--
-- НЕсекретные кнобы (rate limits, квоты, cache TTL, DeBank history maxPages,
-- интервал авто-рефреша). В отличие от integration_secrets — не шифруются.
-- value хранится текстом; тип задаётся каталогом (app-settings.catalog.ts)
-- и дублируется в value_type для защитного парсинга. Пустое value / отсутствие
-- строки = дефолт из env/каталога.

CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  value_type  TEXT NOT NULL,
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_settings_updated_at_idx
  ON app_settings (updated_at DESC);
