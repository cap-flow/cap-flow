import {
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./users.js";
import { wallets } from "./wallets.js";

/**
 * UCB C1: client-supplied cost basis seeds for CEX deposits.
 *
 * Mirror migration 0020_cex_deposit_seeds.sql. См. описание там.
 */
export const cexDepositSeeds = pgTable(
  "cex_deposit_seeds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    txHash: text("tx_hash").notNull(),
    chain: text("chain").notNull(),
    costBasisUsd: numeric("cost_basis_usd", {
      precision: 20,
      scale: 6,
    }).notNull(),
    walletId: uuid("wallet_id").references(() => wallets.id, {
      onDelete: "set null",
    }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("cex_deposit_seeds_user_hash_uq").on(table.userId, table.txHash),
    index("cex_deposit_seeds_user_idx").on(table.userId),
  ],
);

export type CexDepositSeedRow = typeof cexDepositSeeds.$inferSelect;
export type NewCexDepositSeedRow = typeof cexDepositSeeds.$inferInsert;
