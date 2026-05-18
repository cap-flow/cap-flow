import {
  boolean,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { chainOperations } from "./chain_operations.js";
import { users } from "./users.js";

/**
 * UCB A3: per-op user-driven overrides for classifier decisions.
 *
 * Mirror migration 0017_chain_operation_annotations.sql. Не объединяем с
 * `chain_operations.raw` чтобы:
 *   1. Re-classify (новая версия classifier'а) НЕ затирала пользовательский
 *      ввод.
 *   2. Иметь чистый audit trail "что юзер исправил руками vs что было
 *      derived автоматически".
 *
 * Все поля nullable — annotation row может existовать с только одним
 * override (e.g. только note без cost basis override).
 */
export const chainOperationAnnotations = pgTable(
  "chain_operation_annotations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chainOpId: uuid("chain_op_id")
      .notNull()
      .references(() => chainOperations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /** Override pair detection: true — force internal, false — force NOT internal. */
    isInternalTransfer: boolean("is_internal_transfer"),
    /** Override classifier startUsd / costBasis (USD). */
    manualCostBasisUsd: numeric("manual_cost_basis_usd", {
      precision: 20,
      scale: 6,
    }),
    /** Re-classify op (e.g. mis-labeled swap → transfer_in). */
    manualOpType: text("manual_op_type"),
    /** Free-text user note visible in UI. */
    note: text("note"),
    /**
     * UCB D8: soft-delete. true = UCB pipeline ignores this op entirely
     * (lots tracker, position tracker, asset rollup, realized PnL).
     * Default false (op processed normally).
     */
    excluded: boolean("excluded").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("chain_op_annotations_op_user_uq").on(
      table.chainOpId,
      table.userId,
    ),
    index("chain_op_annotations_user_idx").on(table.userId),
  ],
);

export type ChainOperationAnnotationRow =
  typeof chainOperationAnnotations.$inferSelect;
export type NewChainOperationAnnotationRow =
  typeof chainOperationAnnotations.$inferInsert;
