import { type Database, schema } from "@cap-flow/db";
import { and, eq, gte, isNull, sql } from "drizzle-orm";

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
    const sub24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // H12 (2026-05-14): single query with LATERAL joins instead of
    // 5 correlated subqueries per row. Previous implementation ran
    // O(N×5) queries for N accounts; under 1000 accounts that's 5000
    // round-trips. Now O(2) total — one LATERAL for the latest
    // snapshot, one aggregated CTE for the 24h counters.
    //
    // We use raw SQL via `db.execute` since Drizzle's lateral support
    // is still rough at this version. Output shape is hand-mapped
    // below.
    const result = await this.db.execute<{
      account_id: string;
      account_name: string;
      owner_id: string;
      owner_email: string | null;
      owner_name: string | null;
      is_primary: boolean;
      last_snapshot_at: Date | null;
      last_snapshot_usd: string | null;
      last_trigger: string | null;
      snapshot_count_24h: number;
      errors_24h: number;
    }>(sql`
      SELECT
        a.id          AS account_id,
        a.name        AS account_name,
        u.id          AS owner_id,
        u.email       AS owner_email,
        u.name        AS owner_name,
        a.is_primary  AS is_primary,
        ls.created_at AS last_snapshot_at,
        -- Bug E (2026-05-25): gross capital (wallet + protocols) WITHOUT
        -- subtracting debt. DeBank totalUsdValue already nets debt out
        -- (see portfolio-refresh.service.ts:75). We sum walletUsd +
        -- protocolsAssetUsd from metrics to recover the gross figure.
        (
          COALESCE((ls.metrics->>'walletUsd')::numeric, 0)
          + COALESCE((ls.metrics->>'protocolsAssetUsd')::numeric, 0)
        ) AS last_snapshot_usd,
        ls.metrics->>'trigger' AS last_trigger,
        COALESCE(s24.cnt, 0)::int AS snapshot_count_24h,
        COALESCE(e24.cnt, 0)::int AS errors_24h
      FROM ${schema.accounts} a
      INNER JOIN ${schema.users} u ON u.id = a.owner_id
      LEFT JOIN LATERAL (
        SELECT created_at, metrics
        FROM ${schema.portfolioSnapshots}
        WHERE account_id = a.id
        ORDER BY created_at DESC
        LIMIT 1
      ) ls ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS cnt
        FROM ${schema.portfolioSnapshots}
        WHERE account_id = a.id AND created_at >= ${sub24h}
      ) s24 ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS cnt
        FROM ${schema.apiUsage}
        WHERE account_id = a.id
          AND created_at >= ${sub24h}
          AND error IS NOT NULL
      ) e24 ON true
      WHERE a.archived_at IS NULL
      ORDER BY a.created_at DESC
    `);

    return result.rows.map((r) => ({
      accountId: r.account_id,
      accountName: r.account_name,
      ownerId: r.owner_id,
      ownerEmail: r.owner_email,
      ownerName: r.owner_name,
      isPrimary: r.is_primary,
      lastSnapshotAt: r.last_snapshot_at,
      lastSnapshotUsd:
        r.last_snapshot_usd !== null && r.last_snapshot_usd !== undefined
          ? Number(r.last_snapshot_usd)
          : null,
      lastTrigger: r.last_trigger,
      snapshotCount24h: Number(r.snapshot_count_24h ?? 0),
      errors24h: Number(r.errors_24h ?? 0),
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
    // Bug E (2026-05-25): gross capital (wallet + protocols) без вычитания
    // debt. См. комментарий выше про DeBank netting.
    const totalUsdRow = await this.db.execute<{ total: string | null }>(sql`
      SELECT COALESCE(SUM(
        COALESCE((ps.metrics->>'walletUsd')::numeric, 0)
        + COALESCE((ps.metrics->>'protocolsAssetUsd')::numeric, 0)
      ), 0) AS total
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
