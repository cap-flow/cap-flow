import {
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Admin-managed override store for upstream integration secrets.
 *
 *   key       — provider identifier matching IntegrationStatus.key
 *               (e.g. "debank", "helius", "alchemy", …).
 *   envVarName — readable hint for what env var this maps to.
 *   value     — current secret. NULL/empty = "cleared, fall back to env".
 *   updatedBy / updatedAt — audit trail.
 *
 * Read path (`AdminIntegrationsService`):
 *   1. Pull all rows from this table → Map<key, value>.
 *   2. Per provider: if DB has non-empty value → use it; else fall back to
 *      `env.<NAME>_API_KEY`.
 *   3. Never return raw value via API — only `configured: bool` and
 *      `valuePreview: "●●●●...xxxx"` (last 4 chars).
 *
 * Write path (`PATCH /admin/integrations/:key`):
 *   - Body { value: string } → upsert (key) with new value.
 *   - Body { value: "" } or DELETE → clear (revert to env-only).
 *   - All writes audit-logged via `audit_log` table.
 *
 * Hot-reload: in-process clients (DeBankClient etc.) read keys at construction
 * via `process.env`. On a successful PATCH we mutate `process.env[<NAME>]`
 * AND ask callers to restart the API for guaranteed effect on long-lived
 * connection pools. UI shows a "restart required" banner accordingly.
 */
export const integrationSecrets = pgTable("integration_secrets", {
  key: text("key").primaryKey(),
  envVarName: text("env_var_name").notNull(),
  value: text("value"),
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type IntegrationSecret = typeof integrationSecrets.$inferSelect;
export type NewIntegrationSecret = typeof integrationSecrets.$inferInsert;
