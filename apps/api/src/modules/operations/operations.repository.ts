import { type Database, schema } from "@cap-flow/db";
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";

export type OperationRow = typeof schema.operations.$inferSelect;
export type NewOperationRow = typeof schema.operations.$inferInsert;

export interface ListOperationsFilter {
  readonly accountId: string;
  readonly from?: string | undefined; // YYYY-MM-DD
  readonly to?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export class OperationsRepository {
  constructor(private readonly db: Database) {}

  async listByAccount(f: ListOperationsFilter): Promise<OperationRow[]> {
    const conds = [eq(schema.operations.accountId, f.accountId)];
    if (f.from) conds.push(gte(schema.operations.date, f.from));
    if (f.to) conds.push(lte(schema.operations.date, f.to));

    return this.db
      .select()
      .from(schema.operations)
      .where(and(...conds))
      .orderBy(asc(schema.operations.date), asc(schema.operations.createdAt))
      .limit(f.limit ?? 5000)
      .offset(f.offset ?? 0);
  }

  /**
   * Stream-friendly variant for the cost-basis worker. Returns *all* rows
   * for the account ordered by (date, createdAt) — FIFO requires strict
   * chronological replay. No date filter because cost basis needs the
   * full history.
   */
  async listAllForReplay(accountId: string): Promise<OperationRow[]> {
    return this.db
      .select()
      .from(schema.operations)
      .where(eq(schema.operations.accountId, accountId))
      .orderBy(asc(schema.operations.date), asc(schema.operations.createdAt));
  }

  async countByAccount(accountId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.operations)
      .where(eq(schema.operations.accountId, accountId));
    return row?.n ?? 0;
  }

  async lastUpdatedAt(accountId: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ ts: schema.operations.updatedAt })
      .from(schema.operations)
      .where(eq(schema.operations.accountId, accountId))
      .orderBy(desc(schema.operations.updatedAt))
      .limit(1);
    return row?.ts ?? null;
  }

  async findById(id: string): Promise<OperationRow | null> {
    const rows = await this.db
      .select()
      .from(schema.operations)
      .where(eq(schema.operations.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Idempotent batch upsert keyed by `(account_id, legacy_id)`.
   *
   * The legacy client app generates a stable UUID per entry, so re-running
   * an import (offline → online sync) updates the row in place rather
   * than creating duplicates. Returns counts so the importer can show a
   * per-batch summary.
   */
  async upsertBatch(rows: NewOperationRow[]): Promise<{
    inserted: number;
    updated: number;
  }> {
    if (rows.length === 0) return { inserted: 0, updated: 0 };

    const returned = await this.db
      .insert(schema.operations)
      .values(rows)
      .onConflictDoUpdate({
        target: [schema.operations.accountId, schema.operations.legacyId],
        set: {
          date: sql`excluded.date`,
          type: sql`excluded.type`,
          source: sql`excluded.source`,
          fromName: sql`excluded.from_name`,
          toName: sql`excluded.to_name`,
          cur1: sql`excluded.cur1`,
          amount1: sql`excluded.amount1`,
          cur2: sql`excluded.cur2`,
          amount2: sql`excluded.amount2`,
          rate: sql`excluded.rate`,
          avgPrice: sql`excluded.avg_price`,
          priceUsd: sql`excluded.price_usd`,
          posType: sql`excluded.pos_type`,
          funds: sql`excluded.funds`,
          loanRate: sql`excluded.loan_rate`,
          loanRateTake: sql`excluded.loan_rate_take`,
          loanFromName: sql`excluded.loan_from_name`,
          loanPosLegacyId: sql`excluded.loan_pos_legacy_id`,
          loanLtv: sql`excluded.loan_ltv`,
          loanLiqPct: sql`excluded.loan_liq_pct`,
          loanLiqPrice: sql`excluded.loan_liq_price`,
          loanCollateralUsd: sql`excluded.loan_collateral_usd`,
          network: sql`excluded.network`,
          commissionNetwork: sql`excluded.commission_network`,
          closeTokenAmount: sql`excluded.close_token_amount`,
          direction: sql`excluded.direction`,
          comment: sql`excluded.comment`,
          updatedAt: sql`now()`,
        },
      })
      .returning({
        id: schema.operations.id,
        // xmax = 0 means an INSERT happened; non-zero = UPDATE. This is the
        // canonical Postgres trick for distinguishing the two paths in a
        // single ON CONFLICT statement.
        wasInsert: sql<boolean>`(xmax = 0)`,
      });

    let inserted = 0;
    let updated = 0;
    for (const r of returned) {
      if (r.wasInsert) inserted++;
      else updated++;
    }
    return { inserted, updated };
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(schema.operations)
      .where(eq(schema.operations.id, id))
      .returning({ id: schema.operations.id });
    return rows.length > 0;
  }

  async deleteAllForAccount(accountId: string): Promise<number> {
    const rows = await this.db
      .delete(schema.operations)
      .where(eq(schema.operations.accountId, accountId))
      .returning({ id: schema.operations.id });
    return rows.length;
  }
}
