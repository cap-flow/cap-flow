import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./users.js";

/**
 * Quick-reply templates для admin chat — общий пул, любой админ может
 * использовать/редактировать. `createdBy` — для аудита (кто завёл).
 */
export const chatTemplates = pgTable(
  "chat_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("chat_templates_order_idx").on(table.sortOrder, table.createdAt),
  ],
);

export type ChatTemplateRow = typeof chatTemplates.$inferSelect;
export type NewChatTemplateRow = typeof chatTemplates.$inferInsert;
