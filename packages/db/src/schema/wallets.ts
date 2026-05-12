import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { accounts } from "./accounts.js";

/**
 * Wallets — a logical grouping of on-chain addresses inside one account.
 *
 * Example: under account "Main", a user has wallets "EVM cold", "EVM hot",
 * "Tron payouts", each containing 1..N addresses. The refresh worker
 * iterates wallets per-account and fetches balances via DeBank/Alchemy.
 *
 * Schema inherited from the legacy pre-SaaS DB (Phase 0 introspect). TS
 * surface is added here so Drizzle can type queries.
 */
export const walletKindEnum = pgEnum("wallet_kind", ["internal", "external"]);

export const wallets = pgTable(
  "wallets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: walletKindEnum("kind").notNull().default("external"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("wallets_account_name_uq").on(table.accountId, table.name),
  ]
);

export type WalletRow = typeof wallets.$inferSelect;
export type NewWalletRow = typeof wallets.$inferInsert;
export type WalletKind = WalletRow["kind"];

/**
 * On-chain addresses attached to wallets.
 *
 * `chains` is an integer[] of EVM chainIds the address holds assets on.
 * For non-EVM (`type ∈ {solana, tron, btc, other}`) it's typically the
 * empty array; the chain is implicit in `type`.
 */
export const walletAddressTypeEnum = pgEnum("wallet_address_type", [
  "evm",
  "solana",
  "tron",
  "btc",
  "other",
]);

export const walletAddresses = pgTable(
  "wallet_addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    walletId: uuid("wallet_id")
      .notNull()
      .references(() => wallets.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    type: walletAddressTypeEnum("type").notNull(),
    chains: integer("chains").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("wallet_addresses_wallet_addr_uq").on(
      table.walletId,
      table.address
    ),
    index("wallet_addresses_addr_idx").on(table.address),
  ]
);

export type WalletAddressRow = typeof walletAddresses.$inferSelect;
export type NewWalletAddressRow = typeof walletAddresses.$inferInsert;
export type WalletAddressType = WalletAddressRow["type"];
