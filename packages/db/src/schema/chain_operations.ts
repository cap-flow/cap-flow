import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { wallets } from "./wallets.js";

/**
 * UCB B5: server-side persistence on-chain ops (DeBank/Helius classified).
 *
 * Зачем существует ОТДЕЛЬНО от `operations`:
 *   - `operations` хранит legacy manual-import fund-tracker model
 *     (date/fromName/toName/amount1/rate). Это **user-entered** records.
 *   - `chain_operations` хранит **machine-classified** ops от DeBank/
 *     Helius после прогона через Capflow-classifier. Frozen JSON shape
 *     совпадает с client-side `ClassifiedOp` interface — позволяет:
 *       1. Cross-device access (login с другого устройства → instant data)
 *       2. Background sync без open browser (BullMQ worker)
 *       3. Cross-wallet UCB graph traversal (этап A1) — query by tx_hash
 *          через все кошельки user'а
 *       4. Server-side cost basis compute (этап C5 UCB orchestrator)
 *
 * Idempotent upsert: `(wallet_id, tx_hash, log_index)` — один tx_hash
 * может содержать несколько log_index'ов (multi-event tx — swap + LP
 * add в одной транзакции).
 *
 * `raw` JSONB — сырой ClassifiedOp как пришёл от DeBank/Helius после
 * classifier. Frozen-shape contract с клиентом: при изменении
 * classifier-логики next sync перепишет raw, никаких schema-миграций.
 */
export const chainOperations = pgTable(
  "chain_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    walletId: uuid("wallet_id")
      .notNull()
      .references(() => wallets.id, { onDelete: "cascade" }),
    chain: text("chain").notNull(),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull().default(0),
    opType: text("op_type").notNull(),
    opTime: timestamp("op_time", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("ok"),
    raw: jsonb("raw").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("chain_operations_wallet_tx_log_uq").on(
      table.walletId,
      table.txHash,
      table.logIndex,
    ),
    index("chain_operations_wallet_time_idx").on(
      table.walletId,
      table.opTime,
    ),
    index("chain_operations_hash_idx").on(table.txHash),
  ],
);

export type ChainOperationRow = typeof chainOperations.$inferSelect;
export type NewChainOperationRow = typeof chainOperations.$inferInsert;
