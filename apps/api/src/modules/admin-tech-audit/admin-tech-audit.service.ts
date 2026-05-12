import { type Database, schema } from "@cap-flow/db";
import { sql } from "drizzle-orm";

export type FindingSeverity = "info" | "warning" | "error";

export interface Finding {
  readonly id: string;
  readonly severity: FindingSeverity;
  readonly category: string;
  readonly message: string;
  readonly accountId?: string;
  readonly userId?: string;
  readonly details?: Record<string, unknown>;
}

/**
 * Auto-detector of cross-account anomalies — what the owner asked for as
 * "технический аудит … выявлять закономерные ошибки".
 *
 * Each checker is a pure SQL query that returns `Finding[]`. Add new
 * checkers by pushing a method into `runAll`. Output is grouped by
 * category so the admin UI can show a count per category and drill in.
 */
export class AdminTechAuditService {
  constructor(private readonly db: Database) {}

  async runAll(): Promise<{
    summary: Record<string, number>;
    findings: Finding[];
  }> {
    const all: Finding[] = [
      ...(await this.usersWithoutAccounts()),
      ...(await this.accountsNeverRefreshed()),
      ...(await this.accountsStaleSnapshots()),
      ...(await this.recentUpstreamErrors()),
      ...(await this.activeAdminsWithoutMfa()),
      ...(await this.invitesNearExpiry()),
    ];

    const summary: Record<string, number> = {};
    for (const f of all) {
      summary[f.category] = (summary[f.category] ?? 0) + 1;
    }
    return { summary, findings: all };
  }

  /** Active users with zero non-archived accounts. Should be rare. */
  private async usersWithoutAccounts(): Promise<Finding[]> {
    const rows = await this.db.execute<{
      id: string;
      email: string | null;
    }>(sql`
      SELECT u.id, u.email
      FROM users u
      WHERE u.status = 'active'
        AND u.role <> 'admin'
        AND NOT EXISTS (
          SELECT 1 FROM accounts a
          WHERE a.owner_id = u.id AND a.archived_at IS NULL
        )
    `);
    return rows.rows.map((r) => ({
      id: `users-without-accounts:${r.id}`,
      severity: "warning" as const,
      category: "users-without-accounts",
      message: `Active user has no account: ${r.email ?? r.id}`,
      userId: r.id,
    }));
  }

  /** Accounts created >24h ago that never produced a snapshot. */
  private async accountsNeverRefreshed(): Promise<Finding[]> {
    const rows = await this.db.execute<{
      id: string;
      name: string;
      owner_email: string | null;
    }>(sql`
      SELECT a.id, a.name, u.email AS owner_email
      FROM accounts a
      JOIN users u ON u.id = a.owner_id
      WHERE a.archived_at IS NULL
        AND a.created_at < now() - INTERVAL '24 hours'
        AND NOT EXISTS (
          SELECT 1 FROM portfolio_snapshots ps WHERE ps.account_id = a.id
        )
    `);
    return rows.rows.map((r) => ({
      id: `account-never-refreshed:${r.id}`,
      severity: "error" as const,
      category: "account-never-refreshed",
      message: `Account "${r.name}" of ${r.owner_email ?? "?"} never refreshed.`,
      accountId: r.id,
    }));
  }

  /** Accounts whose most recent snapshot is >7 days old. */
  private async accountsStaleSnapshots(): Promise<Finding[]> {
    const rows = await this.db.execute<{
      id: string;
      name: string;
      owner_email: string | null;
      last_refresh: string | null;
    }>(sql`
      SELECT a.id, a.name, u.email AS owner_email,
             (SELECT MAX(created_at) FROM portfolio_snapshots
              WHERE account_id = a.id) AS last_refresh
      FROM accounts a
      JOIN users u ON u.id = a.owner_id
      WHERE a.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM portfolio_snapshots WHERE account_id = a.id)
        AND (SELECT MAX(created_at) FROM portfolio_snapshots
             WHERE account_id = a.id) < now() - INTERVAL '7 days'
    `);
    return rows.rows.map((r) => ({
      id: `account-stale:${r.id}`,
      severity: "warning" as const,
      category: "account-stale-snapshot",
      message: `Account "${r.name}" of ${r.owner_email ?? "?"} last refreshed ${r.last_refresh ?? "?"}.`,
      accountId: r.id,
      details: { lastRefresh: r.last_refresh },
    }));
  }

  /** Upstream-provider error spikes in the last 24h. */
  private async recentUpstreamErrors(): Promise<Finding[]> {
    const rows = await this.db.execute<{
      provider: string;
      error_count: string;
    }>(sql`
      SELECT provider, COUNT(*) AS error_count
      FROM api_usage
      WHERE created_at >= now() - INTERVAL '24 hours'
        AND error IS NOT NULL
      GROUP BY provider
      HAVING COUNT(*) >= 5
    `);
    return rows.rows.map((r) => ({
      id: `provider-errors-24h:${r.provider}`,
      severity: "warning" as const,
      category: "upstream-errors-spike",
      message: `Provider '${r.provider}' had ${r.error_count} errors in the last 24h.`,
      details: { provider: r.provider, count: Number(r.error_count) },
    }));
  }

  /** Active admin without 2FA. (2FA wiring is Phase 9 — until then,
   *  email_verified_at is the closest proxy we have.) */
  private async activeAdminsWithoutMfa(): Promise<Finding[]> {
    const rows = await this.db.execute<{
      id: string;
      email: string | null;
    }>(sql`
      SELECT id, email
      FROM users
      WHERE role = 'admin'
        AND status = 'active'
        AND email_verified_at IS NULL
    `);
    return rows.rows.map((r) => ({
      id: `admin-no-mfa:${r.id}`,
      severity: "info" as const,
      category: "admin-not-verified",
      message: `Admin ${r.email ?? r.id} has no email_verified_at. Wire 2FA in Phase 9.`,
      userId: r.id,
    }));
  }

  /** Pending invites that will expire within 12h. Helps the admin pre-empt
   *  the user calling to say "the link doesn't work". */
  private async invitesNearExpiry(): Promise<Finding[]> {
    const rows = await this.db.execute<{
      id: string;
      email: string;
      expires_at: string;
    }>(sql`
      SELECT id, email, expires_at
      FROM invites
      WHERE status = 'pending'
        AND expires_at BETWEEN now() AND now() + INTERVAL '12 hours'
    `);
    return rows.rows.map((r) => ({
      id: `invite-near-expiry:${r.id}`,
      severity: "info" as const,
      category: "invite-near-expiry",
      message: `Invite for ${r.email} expires at ${r.expires_at}.`,
      details: { inviteId: r.id, email: r.email, expiresAt: r.expires_at },
    }));
  }
}

// `schema` import is intentional even if narrow-used — pulled in so type
// inference picks up the column names. Keeps drizzle inference happy in the
// presence of sql template literals only.
void schema;
