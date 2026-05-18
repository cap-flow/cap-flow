import {
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { accounts } from "./accounts.js";
import { users } from "./users.js";

/**
 * CEX-exchange connection per user.
 *
 *   exchange      — 'bybit' | 'okx' | 'bitget' | 'mexc' | …
 *   label         — user-supplied: "Main", "Trading", "MEXC archive".
 *   apiKeyEnc     — AES-256-GCM ciphertext (see secret-cipher.ts). The
 *                   plaintext key NEVER lives on disk.
 *   apiSecretEnc  — same encryption.
 *   apiPassphraseEnc — OKX and Bitget require an extra passphrase.
 *   permissions   — snapshot of what the key can do (`{read: true,
 *                   trade: false, withdraw: false}`). We probe at
 *                   connect-time and refuse keys with trade/withdraw
 *                   enabled — defense in depth even if the user
 *                   accidentally created a too-permissive key.
 *   lastSyncedAt  — set after each successful sync; null = never synced.
 *   lastSyncError — last error message (truncated); null on success.
 */
export const cexAccounts = pgTable(
  "cex_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    exchange: text("exchange").notNull(),
    label: text("label"),
    apiKeyEnc: text("api_key_enc").notNull(),
    apiSecretEnc: text("api_secret_enc").notNull(),
    apiPassphraseEnc: text("api_passphrase_enc"),
    permissions: jsonb("permissions"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastSyncError: text("last_sync_error"),
    /**
     * Когда последний раз УСПЕШНО потянули trade history. Null если
     * никогда (новый аккаунт, permission denied, биржа не поддерживает).
     * Отдельно от `last_synced_at` потому что balance-sync может
     * проходить, а trades — падать с permission-error. UCB B1.
     */
    lastTradesSyncAt: timestamp("last_trades_sync_at", { withTimezone: true }),
    /**
     * Текст ошибки последнего attempt вытащить trades. Null если
     * последний attempt был успешный (или ещё не пробовали). UI
     * показывает actionable guidance: «Trade history permission off —
     * issue new API key с этой permission и нажмите Re-probe».
     */
    lastTradesSyncError: text("last_trades_sync_error"),
    /**
     * UCB B3: per-exchange internal transfers (Spot↔Funding↔Earn↔Sub).
     * Отдельно от `last_synced_at` / `last_trades_sync_at` — biggest
     * exchanges (bybit/binance) сваливают этот endpoint в permission denied
     * даже когда trades работают, и наоборот.
     */
    lastInternalTransfersSyncAt: timestamp("last_internal_transfers_sync_at", {
      withTimezone: true,
    }),
    lastInternalTransfersSyncError: text("last_internal_transfers_sync_error"),
    /**
     * UCB B4: fetchLedger sync — master record всех balance-affecting
     * entries (trades + deposits + withdrawals + transfers + fees +
     * rebates + interest + staking + funding). Comprehensive stream
     * который покрывает данные, не возвращаемые отдельными endpoint'ами
     * (e.g., staking interest, fee rebates).
     */
    lastLedgerSyncAt: timestamp("last_ledger_sync_at", { withTimezone: true }),
    lastLedgerSyncError: text("last_ledger_sync_error"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("cex_accounts_user_idx").on(table.userId),
    index("cex_accounts_account_idx").on(table.accountId),
  ]
);

export type CexAccount = typeof cexAccounts.$inferSelect;
export type NewCexAccount = typeof cexAccounts.$inferInsert;

/**
 * Per-asset balance snapshot from a CEX account. One row per
 * (cex_account, asset, account_type, snapshot_at). The worker writes
 * a new snapshot every sync tick — historical timeline preserved for
 * the same TVL-chart treatment as `portfolio_snapshots`.
 */
export const cexBalances = pgTable(
  "cex_balances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cexAccountId: uuid("cex_account_id")
      .notNull()
      .references(() => cexAccounts.id, { onDelete: "cascade" }),
    asset: text("asset").notNull(),
    /** 'spot' | 'margin' | 'futures' | 'earn' | 'funding' — kept loose
     *  on purpose, different exchanges expose different sub-accounts. */
    accountType: text("account_type").notNull().default("spot"),
    free: numeric("free", { precision: 28, scale: 8 }).notNull().default("0"),
    used: numeric("used", { precision: 28, scale: 8 }).notNull().default("0"),
    total: numeric("total", { precision: 28, scale: 8 }).notNull().default("0"),
    /** Spot price at snapshot time. Best-effort; may be NULL when
     *  exchange API doesn't expose it for an exotic asset. */
    priceUsd: numeric("price_usd", { precision: 28, scale: 8 }),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("cex_balances_account_snapshot_idx").on(
      table.cexAccountId,
      table.snapshotAt
    ),
  ]
);

export type CexBalance = typeof cexBalances.$inferSelect;

/**
 * Single trade fill from the exchange. Idempotent insert by
 * (cex_account_id, exchange_trade_id). Used as raw source data for the
 * unified `operations` ledger downstream (so FIFO/LIFO/WAC work across
 * CEX + DeFi).
 */
export const cexTrades = pgTable(
  "cex_trades",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cexAccountId: uuid("cex_account_id")
      .notNull()
      .references(() => cexAccounts.id, { onDelete: "cascade" }),
    exchangeTradeId: text("exchange_trade_id").notNull(),
    symbol: text("symbol").notNull(),
    side: text("side").notNull(),
    amount: numeric("amount", { precision: 28, scale: 8 }).notNull(),
    price: numeric("price", { precision: 28, scale: 8 }).notNull(),
    cost: numeric("cost", { precision: 28, scale: 8 }).notNull(),
    feeCurrency: text("fee_currency"),
    feeAmount: numeric("fee_amount", { precision: 28, scale: 8 }),
    taker: text("taker"),
    executedAt: timestamp("executed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("cex_trades_account_tradeid_uq").on(
      table.cexAccountId,
      table.exchangeTradeId
    ),
    index("cex_trades_account_time_idx").on(
      table.cexAccountId,
      table.executedAt
    ),
  ]
);

export type CexTrade = typeof cexTrades.$inferSelect;

/**
 * P2P (peer-to-peer / fiat) order from the exchange's C2C marketplace.
 *
 * P2P orders are NOT covered by CCXT's unified `fetchMyTrades` — each
 * exchange exposes them through a separate REST API with its own scope.
 * The crypto leg moves into/out of the spot wallet on settlement, so
 * from cost-basis perspective these orders are the entry/exit point for
 * the user's fiat capital.
 *
 *   side          — 'buy' = received `asset`, paid `fiat_amount`
 *                   'sell' = sent `asset`, received `fiat_amount`
 *   unit_price    — denormalized fiat-per-crypto (fiat_amount / amount).
 *   status        — exchange-specific. We keep only completed orders in
 *                   the long run, but failures (cancelled, appealed) are
 *                   useful for diagnostics so we don't filter on insert.
 */
export const cexP2pOrders = pgTable(
  "cex_p2p_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cexAccountId: uuid("cex_account_id")
      .notNull()
      .references(() => cexAccounts.id, { onDelete: "cascade" }),
    exchangeOrderId: text("exchange_order_id").notNull(),
    side: text("side").notNull(),
    asset: text("asset").notNull(),
    amount: numeric("amount", { precision: 28, scale: 8 }).notNull(),
    /** Nullable: Bitget retail tax API doesn't expose fiat leg
     *  (only merchant API does). Other exchanges may also redact. */
    fiatCurrency: text("fiat_currency"),
    fiatAmount: numeric("fiat_amount", { precision: 28, scale: 8 }),
    unitPrice: numeric("unit_price", { precision: 28, scale: 8 }),
    counterparty: text("counterparty"),
    paymentMethod: text("payment_method"),
    status: text("status").notNull(),
    /** Where the fiat-leg fields came from:
     *  'api' (default, often null fiat), 'manual', 'csv', 'merchant'. */
    fiatSource: text("fiat_source").notNull().default("api"),
    executedAt: timestamp("executed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("cex_p2p_orders_account_orderid_uq").on(
      table.cexAccountId,
      table.exchangeOrderId
    ),
    index("cex_p2p_orders_account_time_idx").on(
      table.cexAccountId,
      table.executedAt
    ),
  ]
);

export type CexP2pOrder = typeof cexP2pOrders.$inferSelect;
export type NewCexP2pOrder = typeof cexP2pOrders.$inferInsert;

/**
 * Crypto deposits TO the exchange and withdrawals FROM it.
 *
 *   direction='deposit'    — user received `asset` into the CEX wallet
 *                            (came from an external address)
 *   direction='withdrawal' — user sent `asset` out of the CEX
 *                            (to an external address)
 *
 * `tx_hash` is the on-chain transaction hash (CCXT's `txid`). Used by
 * the dashboard to MATCH a CEX transfer with the corresponding op on
 * the user's non-custodial wallet — same hash on both sides means the
 * pair represents the same money movement; we tag both as
 * "internal: ↔ Bitget" so cost-basis isn't double-counted.
 *
 * `network` is the chain the move happened on, as reported by the
 * exchange (e.g. "ETH", "ARBITRUM", "BSC"). Useful for surfacing
 * "wrong network" mistakes and for downstream gas/cost analysis.
 */
export const cexTransfers = pgTable(
  "cex_transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cexAccountId: uuid("cex_account_id")
      .notNull()
      .references(() => cexAccounts.id, { onDelete: "cascade" }),
    exchangeTransferId: text("exchange_transfer_id").notNull(),
    direction: text("direction").notNull(),
    asset: text("asset").notNull(),
    amount: numeric("amount", { precision: 28, scale: 8 }).notNull(),
    feeAmount: numeric("fee_amount", { precision: 28, scale: 8 }),
    feeCurrency: text("fee_currency"),
    network: text("network"),
    address: text("address"),
    txHash: text("tx_hash"),
    status: text("status").notNull(),
    executedAt: timestamp("executed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("cex_transfers_account_tid_uq").on(
      table.cexAccountId,
      table.exchangeTransferId
    ),
    index("cex_transfers_account_time_idx").on(
      table.cexAccountId,
      table.executedAt
    ),
    index("cex_transfers_tx_hash_idx").on(table.txHash),
  ]
);

export type CexTransfer = typeof cexTransfers.$inferSelect;
export type NewCexTransfer = typeof cexTransfers.$inferInsert;

/**
 * UCB B3: internal CEX transfers (Spot ↔ Funding ↔ Earn ↔ Sub-account).
 *
 * Отдельная таблица от `cex_transfers` (внешние deposits/withdrawals)
 * потому что shape принципиально разный: вместо on-chain hash + network +
 * address — два account-type'а (from / to). CCXT отдаёт их через
 * `fetchTransfers`, не `fetchDeposits/Withdrawals`.
 *
 * Зачем критично: без этой таблицы у нас "дыра" в cex balance calc —
 * spot.withdraw(USDT → earn) виден как withdrawal, но прихода на earn
 * мы не знаем; в результате наш расчёт показывает "юзер вывел USDT
 * куда-то", хотя deньги остались на бирже.
 */
export const cexInternalTransfers = pgTable(
  "cex_internal_transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cexAccountId: uuid("cex_account_id")
      .notNull()
      .references(() => cexAccounts.id, { onDelete: "cascade" }),
    exchangeTransferId: text("exchange_transfer_id").notNull(),
    asset: text("asset").notNull(),
    amount: numeric("amount", { precision: 36, scale: 18 }).notNull(),
    /** Source account type: "spot" / "funding" / "earn" / "sub:<name>" / ... */
    fromAccount: text("from_account").notNull(),
    toAccount: text("to_account").notNull(),
    status: text("status").notNull().default("ok"),
    executedAt: timestamp("executed_at", { withTimezone: true }).notNull(),
    /** Сырой CCXT response — для debugging и re-classify без re-sync. */
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("cex_internal_transfers_account_id_uq").on(
      table.cexAccountId,
      table.exchangeTransferId,
    ),
    index("cex_internal_transfers_account_time_idx").on(
      table.cexAccountId,
      table.executedAt,
    ),
  ],
);

export type CexInternalTransfer = typeof cexInternalTransfers.$inferSelect;
export type NewCexInternalTransfer =
  typeof cexInternalTransfers.$inferInsert;

/**
 * UCB B4: CEX ledger — master record всех balance-affecting entries.
 *
 * Через CCXT `fetchLedger` биржа возвращает comprehensive stream:
 *   - trade fills (spot/futures)
 *   - deposits + withdrawals
 *   - internal transfers (sub-account)
 *   - fees (отдельные entries, не только trade.fee)
 *   - rebates / cashback (maker fee returns, referral bonuses)
 *   - interest (savings/lending products)
 *   - staking rewards / earn yields
 *   - funding rates (perp positions)
 *
 * Используется как master/canonical source для cost-basis cross-check.
 * Некоторые типы income (staking interest, fee rebates) ОТСУТСТВУЮТ в
 * fetchMyTrades/fetchDeposits — только в ledger.
 */
export const cexLedger = pgTable(
  "cex_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cexAccountId: uuid("cex_account_id")
      .notNull()
      .references(() => cexAccounts.id, { onDelete: "cascade" }),
    /** Unique exchange-side id (для idempotent insert). */
    exchangeEntryId: text("exchange_entry_id").notNull(),
    /** "spot" / "funding" / "futures" / "earn" / "sub:<name>" / null. */
    account: text("account"),
    asset: text("asset").notNull(),
    /** Always positive. Sign in `direction`. */
    amount: numeric("amount", { precision: 36, scale: 18 }).notNull(),
    /** "in" | "out". */
    direction: text("direction").notNull(),
    /**
     * Normalized type: trade | deposit | withdrawal | transfer | fee |
     * rebate | interest | staking | funding | other.
     */
    type: text("type").notNull(),
    /** Linking ID: order_id, transfer_id, deposit_id. */
    referenceId: text("reference_id"),
    feeAmount: numeric("fee_amount", { precision: 36, scale: 18 }),
    feeCurrency: text("fee_currency"),
    status: text("status").notNull().default("ok"),
    executedAt: timestamp("executed_at", { withTimezone: true }).notNull(),
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("cex_ledger_account_id_uq").on(
      table.cexAccountId,
      table.exchangeEntryId,
    ),
    index("cex_ledger_account_time_idx").on(
      table.cexAccountId,
      table.executedAt,
    ),
    index("cex_ledger_account_asset_type_idx").on(
      table.cexAccountId,
      table.asset,
      table.type,
    ),
  ],
);

export type CexLedger = typeof cexLedger.$inferSelect;
export type NewCexLedger = typeof cexLedger.$inferInsert;
