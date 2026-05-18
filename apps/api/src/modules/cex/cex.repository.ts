import { type Database, schema } from "@cap-flow/db";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";

export type CexAccountRow = typeof schema.cexAccounts.$inferSelect;
export type NewCexAccountRow = typeof schema.cexAccounts.$inferInsert;
export type CexBalanceRow = typeof schema.cexBalances.$inferSelect;
export type CexTradeRow = typeof schema.cexTrades.$inferSelect;
export type CexP2pOrderRow = typeof schema.cexP2pOrders.$inferSelect;
export type CexTransferRow = typeof schema.cexTransfers.$inferSelect;
export type CexInternalTransferRow =
  typeof schema.cexInternalTransfers.$inferSelect;

export interface InsertCexAccountInput {
  readonly userId: string;
  readonly accountId: string;
  readonly exchange: string;
  readonly label: string | null;
  readonly apiKeyEnc: string;
  readonly apiSecretEnc: string;
  readonly apiPassphraseEnc: string | null;
  readonly permissions: unknown;
}

export class CexRepository {
  constructor(private readonly db: Database) {}

  async insertAccount(input: InsertCexAccountInput): Promise<CexAccountRow> {
    const [row] = await this.db
      .insert(schema.cexAccounts)
      .values({
        userId: input.userId,
        accountId: input.accountId,
        exchange: input.exchange,
        label: input.label,
        apiKeyEnc: input.apiKeyEnc,
        apiSecretEnc: input.apiSecretEnc,
        apiPassphraseEnc: input.apiPassphraseEnc,
        permissions: input.permissions,
      })
      .returning();
    if (!row) throw new Error("cex_accounts insert returned no row.");
    return row;
  }

  async findActiveById(
    id: string,
    userId: string
  ): Promise<CexAccountRow | null> {
    const rows = await this.db
      .select()
      .from(schema.cexAccounts)
      .where(
        and(
          eq(schema.cexAccounts.id, id),
          eq(schema.cexAccounts.userId, userId),
          isNull(schema.cexAccounts.archivedAt)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async listActiveForUser(userId: string): Promise<CexAccountRow[]> {
    return this.db
      .select()
      .from(schema.cexAccounts)
      .where(
        and(
          eq(schema.cexAccounts.userId, userId),
          isNull(schema.cexAccounts.archivedAt)
        )
      )
      .orderBy(asc(schema.cexAccounts.createdAt));
  }

  async archive(id: string, userId: string): Promise<void> {
    await this.db
      .update(schema.cexAccounts)
      .set({ archivedAt: new Date() })
      .where(
        and(
          eq(schema.cexAccounts.id, id),
          eq(schema.cexAccounts.userId, userId)
        )
      );
  }

  async markSyncSuccess(id: string): Promise<void> {
    await this.db
      .update(schema.cexAccounts)
      .set({ lastSyncedAt: new Date(), lastSyncError: null })
      .where(eq(schema.cexAccounts.id, id));
  }

  async markSyncError(id: string, errorMsg: string): Promise<void> {
    await this.db
      .update(schema.cexAccounts)
      .set({ lastSyncError: errorMsg.slice(0, 500) })
      .where(eq(schema.cexAccounts.id, id));
  }

  /**
   * Обновляет `permissions` JSONB на снэпшоте из probe'а. Вызывается
   * в `connect()` (первый раз) и на каждом `sync()` (refresh).
   *
   * JSONB не ломает старых консьюмеров: новые поля
   * (tradeHistory/deposits/withdrawals/lastProbedAt) просто появляются
   * рядом с read/trade/withdraw/unknown. UCB B1.
   */
  async updatePermissions(
    id: string,
    permissions: Record<string, unknown>,
  ): Promise<void> {
    await this.db
      .update(schema.cexAccounts)
      .set({ permissions })
      .where(eq(schema.cexAccounts.id, id));
  }

  /**
   * Trade-history sync был успешный. Очищает error, выставляет timestamp
   * последнего успешного pull'а. Отдельно от `markSyncSuccess` потому
   * что balance может OK, а trades — нет (или наоборот).
   */
  async markTradesSyncSuccess(id: string): Promise<void> {
    await this.db
      .update(schema.cexAccounts)
      .set({ lastTradesSyncAt: new Date(), lastTradesSyncError: null })
      .where(eq(schema.cexAccounts.id, id));
  }

  /**
   * Trade-history sync упал. Пишет error message, НЕ трогает
   * `lastTradesSyncAt` (он держит «когда последний раз успешно
   * получали», не «когда последний раз пробовали»). UI: «Trade
   * history: 3d ago ⚠ permission denied».
   */
  async markTradesSyncError(id: string, errorMsg: string): Promise<void> {
    await this.db
      .update(schema.cexAccounts)
      .set({ lastTradesSyncError: errorMsg.slice(0, 500) })
      .where(eq(schema.cexAccounts.id, id));
  }

  /**
   * Atomic balance snapshot: one round-trip per sync, all rows share
   * the same `snapshot_at` so analytics queries can group by it.
   */
  async insertBalanceSnapshot(
    cexAccountId: string,
    snapshotAt: Date,
    lines: ReadonlyArray<{
      asset: string;
      accountType: string;
      free: number;
      used: number;
      total: number;
      priceUsd?: number;
    }>
  ): Promise<void> {
    if (lines.length === 0) return;
    await this.db.insert(schema.cexBalances).values(
      lines.map((l) => ({
        cexAccountId,
        asset: l.asset,
        accountType: l.accountType,
        free: l.free.toString(),
        used: l.used.toString(),
        total: l.total.toString(),
        priceUsd: l.priceUsd != null ? l.priceUsd.toString() : null,
        snapshotAt,
      }))
    );
  }

  async latestBalanceSnapshot(
    cexAccountId: string
  ): Promise<CexBalanceRow[]> {
    const rows = await this.db.execute<CexBalanceRow>(sql`
      SELECT b.* FROM ${schema.cexBalances} b
      WHERE b.cex_account_id = ${cexAccountId}
        AND b.snapshot_at = (
          SELECT MAX(snapshot_at) FROM ${schema.cexBalances}
          WHERE cex_account_id = ${cexAccountId}
        )
    `);
    return rows.rows;
  }

  /**
   * Bulk-upsert trades. Skips duplicates via the unique
   * (cex_account_id, exchange_trade_id) index. Returns the number of
   * NEW rows inserted (= the number of trades not previously seen).
   */
  async upsertTrades(
    cexAccountId: string,
    trades: ReadonlyArray<{
      id: string;
      symbol: string;
      side: "buy" | "sell";
      amount: number;
      price: number;
      cost: number;
      feeCurrency: string | null;
      feeAmount: number | null;
      taker: string | null;
      executedAt: Date;
    }>,
    /**
     * UCB B6: для CSV-import path — `mode='overwrite'`. При duplicate
     * `(account, exchange_trade_id)` обновляем все non-key поля
     * (executed_at, amount, price, …). Это позволяет user'у re-import
     * после parser-fix-а: старый row с broken timestamp заменяется
     * на корректный. Default — `'skip'` для API-sync (avoid races).
     */
    mode: "skip" | "overwrite" = "skip",
  ): Promise<number> {
    if (trades.length === 0) return 0;
    const baseInsert = this.db.insert(schema.cexTrades).values(
      trades.map((t) => ({
        cexAccountId,
        exchangeTradeId: t.id,
        symbol: t.symbol,
        side: t.side,
        amount: t.amount.toString(),
        price: t.price.toString(),
        cost: t.cost.toString(),
        feeCurrency: t.feeCurrency,
        feeAmount: t.feeAmount != null ? t.feeAmount.toString() : null,
        taker: t.taker,
        executedAt: t.executedAt,
      })),
    );
    const target = [
      schema.cexTrades.cexAccountId,
      schema.cexTrades.exchangeTradeId,
    ];
    const op =
      mode === "overwrite"
        ? baseInsert.onConflictDoUpdate({
            target,
            set: {
              symbol: sql`EXCLUDED.symbol`,
              side: sql`EXCLUDED.side`,
              amount: sql`EXCLUDED.amount`,
              price: sql`EXCLUDED.price`,
              cost: sql`EXCLUDED.cost`,
              feeCurrency: sql`EXCLUDED.fee_currency`,
              feeAmount: sql`EXCLUDED.fee_amount`,
              taker: sql`EXCLUDED.taker`,
              executedAt: sql`EXCLUDED.executed_at`,
            },
          })
        : baseInsert.onConflictDoNothing({ target });
    const inserted = await op.returning({ id: schema.cexTrades.id });
    return inserted.length;
  }

  async listTradesForAccount(cexAccountId: string): Promise<CexTradeRow[]> {
    return this.db
      .select()
      .from(schema.cexTrades)
      .where(eq(schema.cexTrades.cexAccountId, cexAccountId))
      .orderBy(asc(schema.cexTrades.executedAt));
  }

  async latestTradeTimestamp(cexAccountId: string): Promise<Date | null> {
    const rows = await this.db
      .select({ t: schema.cexTrades.executedAt })
      .from(schema.cexTrades)
      .where(eq(schema.cexTrades.cexAccountId, cexAccountId))
      .orderBy(desc(schema.cexTrades.executedAt))
      .limit(1);
    return rows[0]?.t ?? null;
  }

  // ─── P2P ──────────────────────────────────────────────────────────

  /**
   * Bulk-upsert P2P orders. Same idempotency contract as `upsertTrades`:
   * (cex_account_id, exchange_order_id) is unique, conflicting rows are
   * skipped. Returns the count of NEW rows.
   */
  async upsertP2pOrders(
    cexAccountId: string,
    orders: ReadonlyArray<{
      id: string;
      side: "buy" | "sell";
      asset: string;
      amount: number;
      fiatCurrency: string | null;
      fiatAmount: number | null;
      unitPrice: number | null;
      counterparty: string | null;
      paymentMethod: string | null;
      status: string;
      executedAt: Date;
    }>
  ): Promise<number> {
    if (orders.length === 0) return 0;
    const inserted = await this.db
      .insert(schema.cexP2pOrders)
      .values(
        orders.map((o) => ({
          cexAccountId,
          exchangeOrderId: o.id,
          side: o.side,
          asset: o.asset,
          amount: o.amount.toString(),
          fiatCurrency: o.fiatCurrency,
          fiatAmount: o.fiatAmount != null ? o.fiatAmount.toString() : null,
          unitPrice: o.unitPrice != null ? o.unitPrice.toString() : null,
          counterparty: o.counterparty,
          paymentMethod: o.paymentMethod,
          status: o.status,
          executedAt: o.executedAt,
        }))
      )
      .onConflictDoNothing({
        target: [
          schema.cexP2pOrders.cexAccountId,
          schema.cexP2pOrders.exchangeOrderId,
        ],
      })
      .returning({ id: schema.cexP2pOrders.id });
    return inserted.length;
  }

  async latestP2pTimestamp(cexAccountId: string): Promise<Date | null> {
    const rows = await this.db
      .select({ t: schema.cexP2pOrders.executedAt })
      .from(schema.cexP2pOrders)
      .where(eq(schema.cexP2pOrders.cexAccountId, cexAccountId))
      .orderBy(desc(schema.cexP2pOrders.executedAt))
      .limit(1);
    return rows[0]?.t ?? null;
  }

  /**
   * Insert a manually-typed P2P order (the user filled in fields by
   * hand because their exchange doesn't expose a P2P API — e.g. BingX
   * — or their key lacks the merchant scope). The synthesized
   * exchange_order_id uses a `manual-` prefix so it can't ever collide
   * with a real one from the upstream sync.
   */
  async insertManualP2pOrder(input: {
    cexAccountId: string;
    side: "buy" | "sell";
    asset: string;
    amount: number;
    fiatCurrency: string;
    fiatAmount: number;
    unitPrice: number;
    counterparty: string | null;
    paymentMethod: string | null;
    status: string;
    executedAt: Date;
  }): Promise<CexP2pOrderRow> {
    const id = `manual-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
    const [row] = await this.db
      .insert(schema.cexP2pOrders)
      .values({
        cexAccountId: input.cexAccountId,
        exchangeOrderId: id,
        side: input.side,
        asset: input.asset.toUpperCase(),
        amount: input.amount.toString(),
        fiatCurrency: input.fiatCurrency.toUpperCase(),
        fiatAmount: input.fiatAmount.toString(),
        unitPrice: input.unitPrice.toString(),
        counterparty: input.counterparty,
        paymentMethod: input.paymentMethod,
        status: input.status,
        fiatSource: "manual",
        executedAt: input.executedAt,
      })
      .returning();
    if (!row) throw new Error("cex_p2p_orders insert returned no row.");
    return row;
  }

  async findP2pOrderById(orderId: string): Promise<CexP2pOrderRow | null> {
    const rows = await this.db
      .select()
      .from(schema.cexP2pOrders)
      .where(eq(schema.cexP2pOrders.id, orderId))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Manually update the fiat-leg fields on a P2P order (the data Bitget
   * doesn't return to retail keys). Source-tag tracks who/how it was
   * filled: 'manual' for a user-typed dialog, 'csv' for bulk import.
   */
  async updateP2pOrderFiat(
    orderId: string,
    patch: {
      fiatCurrency?: string | null;
      fiatAmount?: number | null;
      unitPrice?: number | null;
      counterparty?: string | null;
      paymentMethod?: string | null;
      fiatSource: "manual" | "csv" | "merchant";
    }
  ): Promise<void> {
    const update: Record<string, unknown> = { fiatSource: patch.fiatSource };
    if (patch.fiatCurrency !== undefined)
      update.fiatCurrency = patch.fiatCurrency;
    if (patch.fiatAmount !== undefined)
      update.fiatAmount =
        patch.fiatAmount != null ? patch.fiatAmount.toString() : null;
    if (patch.unitPrice !== undefined)
      update.unitPrice =
        patch.unitPrice != null ? patch.unitPrice.toString() : null;
    if (patch.counterparty !== undefined)
      update.counterparty = patch.counterparty;
    if (patch.paymentMethod !== undefined)
      update.paymentMethod = patch.paymentMethod;
    await this.db
      .update(schema.cexP2pOrders)
      .set(update)
      .where(eq(schema.cexP2pOrders.id, orderId));
  }

  async listP2pOrders(
    cexAccountId: string,
    limit = 200
  ): Promise<CexP2pOrderRow[]> {
    return this.db
      .select()
      .from(schema.cexP2pOrders)
      .where(eq(schema.cexP2pOrders.cexAccountId, cexAccountId))
      .orderBy(desc(schema.cexP2pOrders.executedAt))
      .limit(limit);
  }

  async listP2pOrdersForAccountAsc(
    cexAccountId: string
  ): Promise<CexP2pOrderRow[]> {
    return this.db
      .select()
      .from(schema.cexP2pOrders)
      .where(eq(schema.cexP2pOrders.cexAccountId, cexAccountId))
      .orderBy(asc(schema.cexP2pOrders.executedAt));
  }

  async listTransfersForAccountAsc(
    cexAccountId: string
  ): Promise<CexTransferRow[]> {
    return this.db
      .select()
      .from(schema.cexTransfers)
      .where(eq(schema.cexTransfers.cexAccountId, cexAccountId))
      .orderBy(asc(schema.cexTransfers.executedAt));
  }

  // ─── Transfers (deposits / withdrawals) ───────────────────────────

  /**
   * Bulk-upsert deposit/withdrawal records. Idempotent via the unique
   * (cex_account_id, exchange_transfer_id) index. Returns the count of
   * NEW rows.
   */
  async upsertTransfers(
    cexAccountId: string,
    transfers: ReadonlyArray<{
      id: string;
      direction: "deposit" | "withdrawal";
      asset: string;
      amount: number;
      feeAmount: number | null;
      feeCurrency: string | null;
      network: string | null;
      address: string | null;
      txHash: string | null;
      status: string;
      executedAt: Date;
    }>
  ): Promise<number> {
    if (transfers.length === 0) return 0;
    const inserted = await this.db
      .insert(schema.cexTransfers)
      .values(
        transfers.map((t) => ({
          cexAccountId,
          exchangeTransferId: t.id,
          direction: t.direction,
          asset: t.asset,
          amount: t.amount.toString(),
          feeAmount: t.feeAmount != null ? t.feeAmount.toString() : null,
          feeCurrency: t.feeCurrency,
          network: t.network,
          address: t.address,
          txHash: t.txHash,
          status: t.status,
          executedAt: t.executedAt,
        }))
      )
      .onConflictDoNothing({
        target: [
          schema.cexTransfers.cexAccountId,
          schema.cexTransfers.exchangeTransferId,
        ],
      })
      .returning({ id: schema.cexTransfers.id });
    return inserted.length;
  }

  async latestTransferTimestamp(cexAccountId: string): Promise<Date | null> {
    const rows = await this.db
      .select({ t: schema.cexTransfers.executedAt })
      .from(schema.cexTransfers)
      .where(eq(schema.cexTransfers.cexAccountId, cexAccountId))
      .orderBy(desc(schema.cexTransfers.executedAt))
      .limit(1);
    return rows[0]?.t ?? null;
  }

  async listTransfers(
    cexAccountId: string,
    limit = 200
  ): Promise<CexTransferRow[]> {
    return this.db
      .select()
      .from(schema.cexTransfers)
      .where(eq(schema.cexTransfers.cexAccountId, cexAccountId))
      .orderBy(desc(schema.cexTransfers.executedAt))
      .limit(limit);
  }

  /**
   * All CEX transfers for any active account of `userId`. Used by the
   * frontend's matching logic to look up "is this on-chain op the
   * counterpart of a CEX transfer?". Limited to ones with a non-null
   * tx_hash (only those can be matched against on-chain ops).
   */
  async listAllTransfersWithHashForUser(
    userId: string,
    limit = 1000
  ): Promise<
    Array<{
      readonly cexAccountId: string;
      readonly exchange: string;
      readonly label: string | null;
      readonly direction: "deposit" | "withdrawal";
      readonly asset: string;
      readonly amount: string;
      readonly txHash: string;
      readonly executedAt: Date;
    }>
  > {
    const rows = await this.db
      .select({
        cexAccountId: schema.cexTransfers.cexAccountId,
        exchange: schema.cexAccounts.exchange,
        label: schema.cexAccounts.label,
        direction: schema.cexTransfers.direction,
        asset: schema.cexTransfers.asset,
        amount: schema.cexTransfers.amount,
        txHash: schema.cexTransfers.txHash,
        executedAt: schema.cexTransfers.executedAt,
      })
      .from(schema.cexTransfers)
      .innerJoin(
        schema.cexAccounts,
        eq(schema.cexAccounts.id, schema.cexTransfers.cexAccountId)
      )
      .where(
        and(
          eq(schema.cexAccounts.userId, userId),
          isNull(schema.cexAccounts.archivedAt),
          sql`${schema.cexTransfers.txHash} IS NOT NULL`
        )
      )
      .orderBy(desc(schema.cexTransfers.executedAt))
      .limit(limit);
    return rows
      .filter((r): r is typeof r & { txHash: string } => r.txHash != null)
      .map((r) => ({
        cexAccountId: r.cexAccountId,
        exchange: r.exchange,
        label: r.label,
        direction: r.direction as "deposit" | "withdrawal",
        asset: r.asset,
        amount: r.amount,
        txHash: r.txHash,
        executedAt: r.executedAt,
      }));
  }

  // ─── UCB B3: internal transfers (Spot ↔ Funding ↔ Earn ↔ Sub-account) ─

  /**
   * Idempotent bulk-insert internal transfers через unique
   * (cex_account_id, exchange_transfer_id) index. Returns count of
   * NEW rows. Existing — пропущены через `onConflictDoNothing`.
   */
  async upsertInternalTransfers(
    cexAccountId: string,
    transfers: ReadonlyArray<{
      id: string;
      asset: string;
      amount: number;
      fromAccount: string;
      toAccount: string;
      status: string;
      executedAt: Date;
      raw: unknown;
    }>,
  ): Promise<number> {
    if (transfers.length === 0) return 0;
    const inserted = await this.db
      .insert(schema.cexInternalTransfers)
      .values(
        transfers.map((t) => ({
          cexAccountId,
          exchangeTransferId: t.id,
          asset: t.asset,
          amount: t.amount.toString(),
          fromAccount: t.fromAccount,
          toAccount: t.toAccount,
          status: t.status,
          executedAt: t.executedAt,
          raw: (t.raw ?? null) as Record<string, unknown> | null,
        })),
      )
      .onConflictDoNothing({
        target: [
          schema.cexInternalTransfers.cexAccountId,
          schema.cexInternalTransfers.exchangeTransferId,
        ],
      })
      .returning({ id: schema.cexInternalTransfers.id });
    return inserted.length;
  }

  async listInternalTransfers(
    cexAccountId: string,
    limit = 200,
  ): Promise<CexInternalTransferRow[]> {
    return this.db
      .select()
      .from(schema.cexInternalTransfers)
      .where(eq(schema.cexInternalTransfers.cexAccountId, cexAccountId))
      .orderBy(desc(schema.cexInternalTransfers.executedAt))
      .limit(limit);
  }

  async latestInternalTransferTimestamp(
    cexAccountId: string,
  ): Promise<Date | null> {
    const rows = await this.db
      .select({ t: schema.cexInternalTransfers.executedAt })
      .from(schema.cexInternalTransfers)
      .where(eq(schema.cexInternalTransfers.cexAccountId, cexAccountId))
      .orderBy(desc(schema.cexInternalTransfers.executedAt))
      .limit(1);
    return rows[0]?.t ?? null;
  }

  async markInternalTransfersSyncSuccess(
    cexAccountId: string,
  ): Promise<void> {
    await this.db
      .update(schema.cexAccounts)
      .set({
        lastInternalTransfersSyncAt: new Date(),
        lastInternalTransfersSyncError: null,
      })
      .where(eq(schema.cexAccounts.id, cexAccountId));
  }

  async markInternalTransfersSyncError(
    cexAccountId: string,
    errorMsg: string,
  ): Promise<void> {
    await this.db
      .update(schema.cexAccounts)
      .set({ lastInternalTransfersSyncError: errorMsg.slice(0, 500) })
      .where(eq(schema.cexAccounts.id, cexAccountId));
  }

  // ─── UCB B4: ledger (master record) ─────────────────────────────────

  async upsertLedgerEntries(
    cexAccountId: string,
    entries: ReadonlyArray<{
      exchangeEntryId: string;
      account: string | null;
      asset: string;
      amount: number;
      direction: "in" | "out";
      type: string;
      referenceId: string | null;
      feeAmount: number | null;
      feeCurrency: string | null;
      status: string;
      executedAt: Date;
      raw: unknown;
    }>,
  ): Promise<number> {
    if (entries.length === 0) return 0;
    const inserted = await this.db
      .insert(schema.cexLedger)
      .values(
        entries.map((e) => ({
          cexAccountId,
          exchangeEntryId: e.exchangeEntryId,
          account: e.account,
          asset: e.asset,
          amount: e.amount.toString(),
          direction: e.direction,
          type: e.type,
          referenceId: e.referenceId,
          feeAmount: e.feeAmount != null ? e.feeAmount.toString() : null,
          feeCurrency: e.feeCurrency,
          status: e.status,
          executedAt: e.executedAt,
          raw: (e.raw ?? null) as Record<string, unknown> | null,
        })),
      )
      .onConflictDoNothing({
        target: [
          schema.cexLedger.cexAccountId,
          schema.cexLedger.exchangeEntryId,
        ],
      })
      .returning({ id: schema.cexLedger.id });
    return inserted.length;
  }

  async latestLedgerTimestamp(cexAccountId: string): Promise<Date | null> {
    const rows = await this.db
      .select({ t: schema.cexLedger.executedAt })
      .from(schema.cexLedger)
      .where(eq(schema.cexLedger.cexAccountId, cexAccountId))
      .orderBy(desc(schema.cexLedger.executedAt))
      .limit(1);
    return rows[0]?.t ?? null;
  }

  async listLedger(
    cexAccountId: string,
    limit = 500,
  ): Promise<(typeof schema.cexLedger.$inferSelect)[]> {
    return this.db
      .select()
      .from(schema.cexLedger)
      .where(eq(schema.cexLedger.cexAccountId, cexAccountId))
      .orderBy(desc(schema.cexLedger.executedAt))
      .limit(limit);
  }

  async markLedgerSyncSuccess(cexAccountId: string): Promise<void> {
    await this.db
      .update(schema.cexAccounts)
      .set({ lastLedgerSyncAt: new Date(), lastLedgerSyncError: null })
      .where(eq(schema.cexAccounts.id, cexAccountId));
  }

  async markLedgerSyncError(
    cexAccountId: string,
    errorMsg: string,
  ): Promise<void> {
    await this.db
      .update(schema.cexAccounts)
      .set({ lastLedgerSyncError: errorMsg.slice(0, 500) })
      .where(eq(schema.cexAccounts.id, cexAccountId));
  }
}
