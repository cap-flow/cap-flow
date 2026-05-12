import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./users.js";

/**
 * Accounts table.
 *
 * Existing columns: legacy_id (UNIQUE), name, owner_id, seeded_from_legacy_id.
 * Phase 0 additions: is_primary, description, settings, archived_at.
 */
export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    legacyId: text("legacy_id"), // existing — nullable after migration for new accounts
    name: text("name").notNull(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    seededFromLegacyId: text("seeded_from_legacy_id"),

    // Phase 0 additions.
    description: text("description"),
    isPrimary: boolean("is_primary").notNull().default(false),
    settings: jsonb("settings").notNull().default({}),
    archivedAt: timestamp("archived_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("accounts_legacy_id_unique").on(table.legacyId),
    index("accounts_owner_idx").on(table.ownerId),
    index("accounts_active_idx").on(table.ownerId, table.archivedAt),
  ]
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
