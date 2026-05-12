import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./users.js";

/**
 * Per-user, per-network receive addresses for USDT subscription payments.
 *
 * The platform owns a master wallet (HD or just a set of pre-generated
 * addresses); each user gets a unique receive address on first request so
 * the payment monitor can attribute incoming transfers to the right user
 * without asking them to put a memo/tag (USDT TRC20 doesn't support memos
 * the way some chains do).
 *
 * Phase 8 ships the table + service that hands out addresses; the actual
 * "where do these come from" is a future op decision (HD wallet vs static
 * pool). The migration leaves `address` open-text so either pattern works.
 */
export const cryptoNetworkEnum = pgEnum("crypto_network", [
  "trc20",
  "erc20",
]);

export const cryptoPaymentAddresses = pgTable(
  "crypto_payment_addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    network: cryptoNetworkEnum("network").notNull(),
    address: text("address").notNull(),
    /** Position in the HD wallet path, when applicable. Null for static pool. */
    derivationIndex: integer("derivation_index"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("crypto_payment_addresses_net_addr_uq").on(
      table.network,
      table.address
    ),
    index("crypto_payment_addresses_user_idx").on(table.userId),
    index("crypto_payment_addresses_active_idx").on(table.active),
  ]
);

export type CryptoPaymentAddressRow =
  typeof cryptoPaymentAddresses.$inferSelect;
export type NewCryptoPaymentAddressRow =
  typeof cryptoPaymentAddresses.$inferInsert;
