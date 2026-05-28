import { type Database, schema } from "@cap-flow/db";
import { and, desc, eq, gte, ilike, lte, or, sql, type SQL } from "drizzle-orm";

type OpType = typeof schema.operations.$inferSelect.type;

export interface AdminOperationsFilter {
  readonly userId?: string | undefined;
  readonly accountId?: string | undefined;
  readonly type?: OpType | undefined;
  readonly network?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly search?: string | undefined;
  readonly limit: number;
  readonly offset: number;
}

export interface AdminOperationRow {
  readonly id: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly ownerId: string;
  readonly ownerEmail: string | null;
  readonly ownerName: string | null;
  readonly date: string;
  readonly type: OpType;
  readonly source: string;
  readonly fromName: string | null;
  readonly toName: string | null;
  readonly cur1: string | null;
  readonly amount1: string | null;
  readonly cur2: string | null;
  readonly amount2: string | null;
  readonly priceUsd: string | null;
  readonly network: string | null;
  readonly comment: string;
  readonly createdAt: Date;
}

export interface AdminOperationsPage {
  readonly items: AdminOperationRow[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/**
 * Cross-account operations registry — the admin "единое окно" over the
 * ledger of every user/account, without impersonation.
 *
 * Operations already live in our own Postgres (manual / import / promoted
 * entries), so this is a pure read with no upstream provider cost. We join
 * accounts + users to surface owner/account identity and paginate with
 * limit/offset (same shape as the per-account endpoint). At moderate scale
 * offset paging is fine; if the table grows hot we can move to keyset on
 * (date, id).
 */
export class AdminOperationsService {
  constructor(private readonly db: Database) {}

  private buildWhere(f: AdminOperationsFilter): SQL | undefined {
    const conds: SQL[] = [];
    if (f.accountId) conds.push(eq(schema.operations.accountId, f.accountId));
    if (f.userId) conds.push(eq(schema.accounts.ownerId, f.userId));
    if (f.type) conds.push(eq(schema.operations.type, f.type));
    if (f.network) conds.push(eq(schema.operations.network, f.network));
    if (f.from) conds.push(gte(schema.operations.date, f.from));
    if (f.to) conds.push(lte(schema.operations.date, f.to));
    if (f.search) {
      const pat = `%${f.search}%`;
      const term = or(
        ilike(schema.operations.fromName, pat),
        ilike(schema.operations.toName, pat),
        ilike(schema.operations.comment, pat),
        ilike(schema.operations.cur1, pat),
        ilike(schema.operations.cur2, pat)
      );
      if (term) conds.push(term);
    }
    return conds.length > 0 ? and(...conds) : undefined;
  }

  async list(f: AdminOperationsFilter): Promise<AdminOperationsPage> {
    const where = this.buildWhere(f);

    const rows = await this.db
      .select({
        id: schema.operations.id,
        accountId: schema.operations.accountId,
        accountName: schema.accounts.name,
        ownerId: schema.accounts.ownerId,
        ownerEmail: schema.users.email,
        ownerName: schema.users.name,
        date: schema.operations.date,
        type: schema.operations.type,
        source: schema.operations.source,
        fromName: schema.operations.fromName,
        toName: schema.operations.toName,
        cur1: schema.operations.cur1,
        amount1: schema.operations.amount1,
        cur2: schema.operations.cur2,
        amount2: schema.operations.amount2,
        priceUsd: schema.operations.priceUsd,
        network: schema.operations.network,
        comment: schema.operations.comment,
        createdAt: schema.operations.createdAt,
      })
      .from(schema.operations)
      .innerJoin(
        schema.accounts,
        eq(schema.accounts.id, schema.operations.accountId)
      )
      .innerJoin(schema.users, eq(schema.users.id, schema.accounts.ownerId))
      .where(where)
      .orderBy(desc(schema.operations.date), desc(schema.operations.createdAt))
      .limit(f.limit)
      .offset(f.offset);

    const totalRow = await this.db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(schema.operations)
      .innerJoin(
        schema.accounts,
        eq(schema.accounts.id, schema.operations.accountId)
      )
      .innerJoin(schema.users, eq(schema.users.id, schema.accounts.ownerId))
      .where(where);

    return {
      items: rows.map((r) => ({
        id: r.id,
        accountId: r.accountId,
        accountName: r.accountName,
        ownerId: r.ownerId,
        ownerEmail: r.ownerEmail,
        ownerName: r.ownerName,
        date: r.date,
        type: r.type,
        source: r.source,
        fromName: r.fromName,
        toName: r.toName,
        cur1: r.cur1,
        amount1: r.amount1,
        cur2: r.cur2,
        amount2: r.amount2,
        priceUsd: r.priceUsd,
        network: r.network,
        comment: r.comment,
        createdAt: r.createdAt,
      })),
      total: Number(totalRow[0]?.n ?? 0),
      limit: f.limit,
      offset: f.offset,
    };
  }

  /** Distinct networks present in the ledger — powers the network filter. */
  async facets(): Promise<{ networks: string[] }> {
    const rows = await this.db
      .selectDistinct({ network: schema.operations.network })
      .from(schema.operations)
      .where(sql`${schema.operations.network} IS NOT NULL`)
      .orderBy(schema.operations.network);
    return {
      networks: rows
        .map((r) => r.network)
        .filter((n): n is string => n !== null && n.length > 0),
    };
  }
}
