import { type Database, schema } from "@cap-flow/db";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";

export interface AdminAccountRow {
  readonly accountId: string;
  readonly accountName: string;
  readonly ownerId: string;
  readonly ownerEmail: string | null;
  readonly ownerName: string | null;
  readonly isPrimary: boolean;
  readonly lastSnapshotAt: Date | null;
  readonly lastSnapshotUsd: number | null;
  readonly lastTrigger: string | null;
  readonly snapshotCount24h: number;
  readonly errors24h: number;
}

export interface PlatformAggregate {
  readonly accountsActive: number;
  readonly usersActive: number;
  readonly totalUsd: number;
  readonly snapshotsLast24h: number;
  readonly errorsLast24h: number;
}

/**
 * One row per active account with admin-level aggregates. Used by the
 * admin "portfolio analytics" table:
 *
 *   logins  account name  TVL ($)  last update  refresh OK / errors (24h)
 *
 * Joins users + accounts + latest snapshot via a correlated subquery so we
 * keep one round-trip. At ~100 accounts this is fine; the same shape can
 * be replaced by a materialised view if it ever becomes hot.
 */
export class AdminPortfoliosService {
  constructor(private readonly db: Database) {}

  async listAllAccounts(): Promise<AdminAccountRow[]> {
    const sub24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const rows = await this.db
      .select({
        accountId: schema.accounts.id,
        accountName: schema.accounts.name,
        ownerId: schema.users.id,
        ownerEmail: schema.users.email,
        ownerName: schema.users.name,
        isPrimary: schema.accounts.isPrimary,
        lastSnapshotAt: sql<Date | null>`
          (SELECT MAX(created_at) FROM ${schema.portfolioSnapshots} ps
           WHERE ps.account_id = ${schema.accounts.id})
        `,
        lastSnapshotUsd: sql<number | null>`
          (SELECT (metrics->>'totalUsd')::numeric
           FROM ${schema.portfolioSnapshots} ps
           WHERE ps.account_id = ${schema.accounts.id}
           ORDER BY ps.created_at DESC LIMIT 1)
        `,
        lastTrigger: sql<string | null>`
          (SELECT metrics->>'trigger'
           FROM ${schema.portfolioSnapshots} ps
           WHERE ps.account_id = ${schema.accounts.id}
           ORDER BY ps.created_at DESC LIMIT 1)
        `,
        snapshotCount24h: sql<number>`
          (SELECT COUNT(*)::int FROM ${schema.portfolioSnapshots} ps
           WHERE ps.account_id = ${schema.accounts.id}
             AND ps.created_at >= ${sub24h.toISOString()})
        `,
        errors24h: sql<number>`
          (SELECT COUNT(*)::int FROM ${schema.apiUsage} au
           WHERE au.account_id = ${schema.accounts.id}
             AND au.created_at >= ${sub24h.toISOString()}
             AND au.error IS NOT NULL)
        `,
      })
      .from(schema.accounts)
      .innerJoin(schema.users, eq(schema.users.id, schema.accounts.ownerId))
      .where(isNull(schema.accounts.archivedAt))
      .orderBy(desc(schema.accounts.createdAt));

    return rows.map((r) => ({
      accountId: r.accountId,
      accountName: r.accountName,
      ownerId: r.ownerId,
      ownerEmail: r.ownerEmail,
      ownerName: r.ownerName,
      isPrimary: r.isPrimary,
      lastSnapshotAt: r.lastSnapshotAt,
      lastSnapshotUsd:
        r.lastSnapshotUsd !== null && r.lastSnapshotUsd !== undefined
          ? Number(r.lastSnapshotUsd)
          : null,
      lastTrigger: r.lastTrigger,
      snapshotCount24h: Number(r.snapshotCount24h ?? 0),
      errors24h: Number(r.errors24h ?? 0),
    }));
  }

  async aggregate(): Promise<PlatformAggregate> {
    const sub24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const accountsCount = await this.db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(schema.accounts)
      .where(isNull(schema.accounts.archivedAt));

    const usersCount = await this.db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(schema.users)
      .where(eq(schema.users.status, "active"));

    // sum( latest snapshot per account ) — a lateral-join pattern.
    const totalUsdRow = await this.db.execute<{ total: string | null }>(sql`
      SELECT COALESCE(SUM((ps.metrics->>'totalUsd')::numeric), 0) AS total
      FROM ${schema.accounts} a
      INNER JOIN LATERAL (
        SELECT metrics FROM ${schema.portfolioSnapshots}
        WHERE account_id = a.id
        ORDER BY created_at DESC LIMIT 1
      ) ps ON true
      WHERE a.archived_at IS NULL
    `);

    const snapshotsCount = await this.db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(schema.portfolioSnapshots)
      .where(gte(schema.portfolioSnapshots.createdAt, sub24h));

    const errorsCount = await this.db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(schema.apiUsage)
      .where(
        and(
          gte(schema.apiUsage.createdAt, sub24h),
          sql`${schema.apiUsage.error} IS NOT NULL`
        )
      );

    const total = totalUsdRow.rows[0]?.total;
    return {
      accountsActive: Number(accountsCount[0]?.n ?? 0),
      usersActive: Number(usersCount[0]?.n ?? 0),
      totalUsd: total !== null && total !== undefined ? Number(total) : 0,
      snapshotsLast24h: Number(snapshotsCount[0]?.n ?? 0),
      errorsLast24h: Number(errorsCount[0]?.n ?? 0),
    };
  }
}
