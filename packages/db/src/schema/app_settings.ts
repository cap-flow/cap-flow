import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Admin-tunable application settings (key-value).
 *
 * В отличие от `integration_secrets` (секреты, шифруются) — здесь НЕсекретные
 * числовые/булевы/строковые «кнобы»: rate limits, квоты, cache TTL, размеры
 * пагинации DeBank-истории, интервал авто-рефреша и т.п. Значения хранятся как
 * текст; тип задаётся каталогом (`app-settings.catalog.ts`) и денормализуется
 * в `value_type` для защитного парсинга.
 *
 *   key        — ключ каталога (e.g. "upstream.ratePerMin", "quota.debankPerDay").
 *   value      — текстовое представление значения. Строка "" трактуется как
 *                «сброшено» (равнозначно отсутствию строки → дефолт из env/каталога).
 *   valueType  — "number" | "boolean" | "string" (копия из каталога).
 *   updatedBy / updatedAt — аудит.
 *
 * Read path (`AppSettingsService`):
 *   1. Загрузить все строки в in-proc кэш (TTL ~10s).
 *   2. Resolution: DB-строка (распарсенная по value_type) → дефолт каталога (из env).
 *   3. PATCH инвалидирует кэш → live-кнобы (rate limits, квоты) подхватываются
 *      без рестарта; «restart»-кнобы (cache TTL, retry) применяются на след. boot.
 */
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value"),
  valueType: text("value_type").notNull(),
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AppSetting = typeof appSettings.$inferSelect;
export type NewAppSetting = typeof appSettings.$inferInsert;
