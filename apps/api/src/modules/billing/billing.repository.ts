import { type Database, schema } from "@cap-flow/db";
import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";

export type CryptoNetwork = "trc20" | "erc20";
export type PaymentAddressRow =
  typeof schema.cryptoPaymentAddresses.$inferSelect;
export type PaymentTxRow = typeof schema.paymentTransactions.$inferSelect;
export type UserPaymentRow = typeof schema.userPayments.$inferSelect;

export interface InsertAddressInput {
  readonly userId: string;
  readonly network: CryptoNetwork;
  readonly address: string;
  readonly derivationIndex: number | null;
}

export interface CreditPaymentInput {
  readonly userId: string;
  readonly amountUsd: string;
  readonly horizonMonths: number;
  readonly plan: "quarterly" | "semiannual" | "yearly" | "custom";
  readonly paymentMethod: "crypto_usdt_trc20" | "crypto_usdt_erc20" | "manual";
  readonly note?: string | null;
  readonly periodEnd: Date;
  /** When provided, also links the tx → payment back-pointer. */
  readonly txId?: string;
}

export class BillingRepository {
  constructor(private readonly db: Database) {}

  // ─── address allocation ───────────────────────────────────────────

  async findUserAddress(
    userId: string,
    network: CryptoNetwork
  ): Promise<PaymentAddressRow | null> {
    const rows = await this.db
      .select()
      .from(schema.cryptoPaymentAddresses)
      .where(
        and(
          eq(schema.cryptoPaymentAddresses.userId, userId),
          eq(schema.cryptoPaymentAddresses.network, network),
          eq(schema.cryptoPaymentAddresses.active, true)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Has this network+address ever been assigned to anyone? Idempotency guard. */
  async findByAddress(
    network: CryptoNetwork,
    address: string
  ): Promise<PaymentAddressRow | null> {
    const rows = await this.db
      .select()
      .from(schema.cryptoPaymentAddresses)
      .where(
        and(
          eq(schema.cryptoPaymentAddresses.network, network),
          eq(schema.cryptoPaymentAddresses.address, address)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async insertAddress(input: InsertAddressInput): Promise<PaymentAddressRow> {
    const [row] = await this.db
      .insert(schema.cryptoPaymentAddresses)
      .values({
        userId: input.userId,
        network: input.network,
        address: input.address,
        derivationIndex: input.derivationIndex,
      })
      .returning();
    if (!row) throw new Error("address insert returned no row");
    return row;
  }

  async listActiveAddresses(): Promise<PaymentAddressRow[]> {
    return this.db
      .select()
      .from(schema.cryptoPaymentAddresses)
      .where(eq(schema.cryptoPaymentAddresses.active, true));
  }

  // ─── payment ledger ───────────────────────────────────────────────

  /**
   * Most recent NON-REFUNDED subscription for a user.
   *
   * Fix B1 (2026-05-14): previous implementation returned any latest
   * subscription regardless of whether a `kind=refund` row pointed at it,
   * letting refunded users retain access until original `period_end`.
   * The `NOT EXISTS` subquery excludes any subscription that has been
   * refunded — admin's `BillingService.refundForUser` now correctly
   * downgrades the user to `beta` (or to the next-most-recent valid
   * subscription, if any).
   */
  async latestActiveSubscription(
    userId: string
  ): Promise<UserPaymentRow | null> {
    const rows = await this.db
      .select()
      .from(schema.userPayments)
      .where(
        and(
          eq(schema.userPayments.userId, userId),
          eq(schema.userPayments.kind, "subscription"),
          isNotNull(schema.userPayments.periodEnd),
          sql`NOT EXISTS (
            SELECT 1 FROM ${schema.userPayments} r
            WHERE r.kind = 'refund'
              AND r.refunded_payment_id = ${schema.userPayments.id}
          )`
        )
      )
      .orderBy(desc(schema.userPayments.periodEnd))
      .limit(1);
    return rows[0] ?? null;
  }

  async paymentHistory(userId: string, limit = 50): Promise<UserPaymentRow[]> {
    return this.db
      .select()
      .from(schema.userPayments)
      .where(eq(schema.userPayments.userId, userId))
      .orderBy(desc(schema.userPayments.paidAt))
      .limit(limit);
  }

  async creditPayment(input: CreditPaymentInput): Promise<UserPaymentRow> {
    const [row] = await this.db
      .insert(schema.userPayments)
      .values({
        userId: input.userId,
        kind: "subscription",
        plan: input.plan,
        amountUsd: input.amountUsd,
        horizonMonths: input.horizonMonths,
        paidAt: new Date(),
        periodEnd: input.periodEnd,
        note: input.note ?? null,
      })
      .returning();
    if (!row) throw new Error("user_payments insert returned no row");
    if (input.txId) {
      await this.db
        .update(schema.paymentTransactions)
        .set({ creditedPaymentId: row.id })
        .where(eq(schema.paymentTransactions.id, input.txId));
    }
    return row;
  }

  async insertRefund(
    userId: string,
    refundedPaymentId: string,
    amountUsd: string,
    note: string | null
  ): Promise<UserPaymentRow> {
    const [row] = await this.db
      .insert(schema.userPayments)
      .values({
        userId,
        kind: "refund",
        plan: "custom",
        amountUsd,
        horizonMonths: 0,
        paidAt: new Date(),
        refundedPaymentId,
        note,
      })
      .returning();
    if (!row) throw new Error("refund insert returned no row");
    return row;
  }

  // ─── observed tx log ──────────────────────────────────────────────

  async upsertTx(input: {
    addressId: string;
    network: CryptoNetwork;
    txHash: string;
    fromAddress: string | null;
    amount: string;
    confirmations: number;
  }): Promise<PaymentTxRow> {
    // Use insert ... on conflict on (network, tx_hash) to bump confirmations.
    const [row] = await this.db
      .insert(schema.paymentTransactions)
      .values({
        addressId: input.addressId,
        network: input.network,
        txHash: input.txHash,
        fromAddress: input.fromAddress,
        amount: input.amount,
        confirmations: input.confirmations,
      })
      .onConflictDoUpdate({
        target: [
          schema.paymentTransactions.network,
          schema.paymentTransactions.txHash,
        ],
        set: { confirmations: input.confirmations },
      })
      .returning();
    if (!row) throw new Error("payment_transactions upsert returned no row");
    return row;
  }

  async findUncreditedTxsReady(minConfTrc: number, minConfErc: number) {
    return this.db
      .select()
      .from(schema.paymentTransactions)
      .where(
        and(
          sql`${schema.paymentTransactions.creditedPaymentId} IS NULL`,
          sql`(
            (${schema.paymentTransactions.network} = 'trc20' AND ${schema.paymentTransactions.confirmations} >= ${minConfTrc})
            OR
            (${schema.paymentTransactions.network} = 'erc20' AND ${schema.paymentTransactions.confirmations} >= ${minConfErc})
          )`
        )
      );
  }

  async listRecentTxs(userId: string, limit = 50): Promise<PaymentTxRow[]> {
    // Join via addresses to filter by user.
    const rows = await this.db
      .select({
        tx: schema.paymentTransactions,
      })
      .from(schema.paymentTransactions)
      .innerJoin(
        schema.cryptoPaymentAddresses,
        eq(
          schema.cryptoPaymentAddresses.id,
          schema.paymentTransactions.addressId
        )
      )
      .where(eq(schema.cryptoPaymentAddresses.userId, userId))
      .orderBy(desc(schema.paymentTransactions.observedAt))
      .limit(limit);
    return rows.map((r) => r.tx);
  }

  /** Counts for the admin dashboard (Phase 5 hookup). */
  async paymentsSince(since: Date) {
    const rows = await this.db
      .select({
        kind: schema.userPayments.kind,
        n: sql<number>`COUNT(*)::int`,
        total: sql<string>`COALESCE(SUM(${schema.userPayments.amountUsd}), 0)::text`,
      })
      .from(schema.userPayments)
      .where(gte(schema.userPayments.paidAt, since))
      .groupBy(schema.userPayments.kind);
    return rows;
  }
}
