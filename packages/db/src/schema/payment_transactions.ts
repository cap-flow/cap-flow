import {
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { cryptoNetworkEnum, cryptoPaymentAddresses } from "./crypto_payment_addresses.js";
import { userPayments } from "./user_payments.js";

/**
 * Append-only log of incoming on-chain transfers observed by the payment
 * monitor worker.
 *
 *   - `(network, tx_hash)` is unique — re-runs of the monitor never
 *     double-count the same transfer.
 *   - `creditedPaymentId` points to the `user_payments` row produced when
 *     the transfer was actually applied. Null = observed but not yet
 *     credited (e.g. amount under minimum, or confirmations too low).
 */
export const paymentTransactions = pgTable(
  "payment_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    addressId: uuid("address_id")
      .notNull()
      .references(() => cryptoPaymentAddresses.id, { onDelete: "cascade" }),
    network: cryptoNetworkEnum("network").notNull(),
    txHash: text("tx_hash").notNull(),
    fromAddress: text("from_address"),
    /** USDT amount in human units (e.g. "100.000000"). */
    amount: numeric("amount", { precision: 28, scale: 8 }).notNull(),
    confirmations: integer("confirmations").notNull().default(0),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    creditedPaymentId: uuid("credited_payment_id").references(
      () => userPayments.id,
      { onDelete: "set null" }
    ),
    note: text("note"),
  },
  (table) => [
    uniqueIndex("payment_transactions_net_hash_uq").on(
      table.network,
      table.txHash
    ),
    index("payment_transactions_address_idx").on(table.addressId),
    index("payment_transactions_observed_idx").on(table.observedAt),
  ]
);

export type PaymentTransactionRow =
  typeof paymentTransactions.$inferSelect;
export type NewPaymentTransactionRow =
  typeof paymentTransactions.$inferInsert;
