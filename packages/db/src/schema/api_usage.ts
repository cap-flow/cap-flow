import {
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { accounts } from "./accounts.js";
import { users } from "./users.js";

/**
 * Per-call log of upstream API requests (Alchemy / DeBank / Etherscan / …).
 *
 * Used to (a) attribute cost to the user/account that triggered the call,
 * (b) feed the admin "API spend" dashboard, (c) drive per-user quotas.
 *
 * High-volume table — keep columns lean and rely on indexes.
 */
export const apiUsage = pgTable(
  "api_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    accountId: uuid("account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    provider: varchar("provider", { length: 40 }).notNull(),
    endpoint: varchar("endpoint", { length: 200 }).notNull(),
    httpStatus: integer("http_status"),
    durationMs: integer("duration_ms"),
    cacheHit: integer("cache_hit").notNull().default(0),
    costEstimateUsd: numeric("cost_estimate_usd", { precision: 12, scale: 6 }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("api_usage_user_id_idx").on(table.userId),
    index("api_usage_provider_idx").on(table.provider),
    index("api_usage_created_idx").on(table.createdAt),
    index("api_usage_provider_time_idx").on(table.provider, table.createdAt),
  ]
);

export type ApiUsageEntry = typeof apiUsage.$inferSelect;
export type NewApiUsageEntry = typeof apiUsage.$inferInsert;
