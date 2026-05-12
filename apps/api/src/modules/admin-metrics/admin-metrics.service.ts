import { type Database } from "@cap-flow/db";
import { sql } from "drizzle-orm";

export interface SaasMetrics {
  readonly users: {
    readonly total: number;
    readonly active: number;
    readonly pending: number;
    readonly blocked: number;
  };
  readonly dau: number;
  readonly wau: number;
  readonly mau: number;
  readonly newUsers: {
    readonly last24h: number;
    readonly last7d: number;
    readonly last30d: number;
  };
  readonly invites: {
    readonly pending: number;
    readonly consumed: number;
    readonly revoked: number;
    readonly expired: number;
  };
  readonly activation: {
    /** Invites consumed within 24h of issue / total invites issued in the window. */
    readonly within24hPct: number;
    /** Users with ≥1 successful refresh within 7 days of registration. */
    readonly firstRefreshWithin7dPct: number;
  };
}

/**
 * Computes the headline SaaS metrics the admin dashboard surfaces.
 *
 * "Active" means a session was touched (login or refresh) in the window —
 * sessions.last_used_at is updated by the worker plugin. For the MVP we
 * approximate via users.last_login_at; once we wire mid-session activity
 * tracking we'll switch.
 */
export class AdminMetricsService {
  constructor(private readonly db: Database) {}

  async compute(): Promise<SaasMetrics> {
    const now = Date.now();
    const d1 = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const d7 = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const d30 = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

    // users by status
    const statusRows = await this.db.execute<{
      status: string;
      n: string;
    }>(sql`SELECT status, COUNT(*) AS n FROM users GROUP BY status`);
    const users = { total: 0, active: 0, pending: 0, blocked: 0 };
    for (const r of statusRows.rows) {
      const n = Number(r.n);
      users.total += n;
      if (r.status === "active") users.active = n;
      if (r.status === "pending") users.pending = n;
      if (r.status === "blocked") users.blocked = n;
    }

    // DAU/WAU/MAU — distinct user_ids active in the window. Activity =
    // a session whose `last_used_at` is within the window.
    const activeRows = await this.db.execute<{
      dau: string;
      wau: string;
      mau: string;
    }>(sql`
      SELECT
        COUNT(DISTINCT user_id) FILTER (WHERE last_used_at >= ${d1}) AS dau,
        COUNT(DISTINCT user_id) FILTER (WHERE last_used_at >= ${d7}) AS wau,
        COUNT(DISTINCT user_id) FILTER (WHERE last_used_at >= ${d30}) AS mau
      FROM sessions
    `);
    const a = activeRows.rows[0];

    // new users in time windows
    const newRows = await this.db.execute<{
      last24h: string;
      last7d: string;
      last30d: string;
    }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= ${d1}) AS last24h,
        COUNT(*) FILTER (WHERE created_at >= ${d7})  AS last7d,
        COUNT(*) FILTER (WHERE created_at >= ${d30}) AS last30d
      FROM users
    `);
    const n = newRows.rows[0];

    // invite status breakdown
    const inviteRows = await this.db.execute<{
      status: string;
      n: string;
    }>(sql`SELECT status, COUNT(*) AS n FROM invites GROUP BY status`);
    const invites = { pending: 0, consumed: 0, revoked: 0, expired: 0 };
    for (const r of inviteRows.rows) {
      const v = Number(r.n);
      if (r.status === "pending") invites.pending = v;
      if (r.status === "consumed") invites.consumed = v;
      if (r.status === "revoked") invites.revoked = v;
      if (r.status === "expired") invites.expired = v;
    }

    // activation: of all invites issued in the last 30d, what % were
    // consumed within 24h of issuance?
    const actRow = await this.db.execute<{
      issued: string;
      fast: string;
    }>(sql`
      SELECT
        COUNT(*) AS issued,
        COUNT(*) FILTER (
          WHERE consumed_at IS NOT NULL
            AND consumed_at <= created_at + INTERVAL '24 hours'
        ) AS fast
      FROM invites
      WHERE created_at >= ${d30}
    `);
    const issued = Number(actRow.rows[0]?.issued ?? 0);
    const fast = Number(actRow.rows[0]?.fast ?? 0);
    const within24hPct = issued > 0 ? Math.round((fast / issued) * 100) : 0;

    // activation 2: % of users registered in last 30d who got ≥1 snapshot
    // successfully written within 7 days of registration.
    const refRow = await this.db.execute<{
      total: string;
      converted: string;
    }>(sql`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (
          WHERE EXISTS (
            SELECT 1 FROM accounts a
            JOIN portfolio_snapshots ps ON ps.account_id = a.id
            WHERE a.owner_id = u.id
              AND ps.created_at <= u.created_at + INTERVAL '7 days'
          )
        ) AS converted
      FROM users u
      WHERE u.created_at >= ${d30}
    `);
    const total = Number(refRow.rows[0]?.total ?? 0);
    const converted = Number(refRow.rows[0]?.converted ?? 0);
    const firstRefreshWithin7dPct =
      total > 0 ? Math.round((converted / total) * 100) : 0;

    return {
      users,
      dau: Number(a?.dau ?? 0),
      wau: Number(a?.wau ?? 0),
      mau: Number(a?.mau ?? 0),
      newUsers: {
        last24h: Number(n?.last24h ?? 0),
        last7d: Number(n?.last7d ?? 0),
        last30d: Number(n?.last30d ?? 0),
      },
      invites,
      activation: {
        within24hPct,
        firstRefreshWithin7dPct,
      },
    };
  }
}
