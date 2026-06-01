import { type Database, schema } from "@cap-flow/db";
import { sql } from "drizzle-orm";

import { DUPLICATE_PRICING_DEFAULTS } from "../anomaly/registry_checks.js";

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
      ...(await this.duplicateOpDivergentPricing()),
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

  /**
   * Upstream-provider unavailability in the last 24h, broken down by HTTP
   * status so the failure MODE drives severity (C5b `upstream_service_unavailable`,
   * the "meta-check priority #1": most silent LP anomalies are an unavailable
   * source, not a calc bug).
   *
   * Severity by mode (a key/credit failure means data SILENTLY vanishes →
   * error; a rate-limit means intermittent loss → warning):
   *   - missing_api_key / 503 / 402 / 403 → **error** (source dropped; this is the
   *     POS-004/005 root cause — Krystal 503 → LP fee/APR/cost basis disappeared).
   *   - 429 → **warning** (rate-limited → "fee то есть, то нет").
   *   - other 5xx / network → **warning** (transient).
   */
  private async recentUpstreamErrors(): Promise<Finding[]> {
    const rows = await this.db.execute<{
      provider: string;
      http_status: number | null;
      error_count: string;
      missing_key: boolean;
    }>(sql`
      SELECT provider, http_status, COUNT(*) AS error_count,
             bool_or(error ILIKE '%missing_api_key%') AS missing_key
      FROM api_usage
      WHERE created_at >= now() - INTERVAL '24 hours'
        AND (http_status >= 400 OR error IS NOT NULL)
      GROUP BY provider, http_status
      HAVING COUNT(*) >= 5
      ORDER BY provider, http_status
    `);
    return rows.rows.map((r) => {
      const status = r.http_status ?? 0;
      const count = Number(r.error_count);
      const isLpSource = /krystal/i.test(r.provider);
      let severity: FindingSeverity;
      let mode: string;
      if (r.missing_key) {
        severity = "error";
        mode = "нет API-ключа → proxy 503 → данные сервиса ТИХО пропадают";
      } else if (status === 503 || status === 402 || status === 403) {
        severity = "error";
        mode =
          status === 402
            ? "нет кредитов (402) → данные тихо пропадают"
            : status === 403
              ? "forbidden (403) — ключ/доступ → данные тихо пропадают"
              : "upstream недоступен (503) → данные тихо пропадают";
      } else if (status === 429) {
        severity = "warning";
        mode = "rate-limited (429) → прерывистая пропажа (то есть, то нет)";
      } else {
        severity = "warning";
        mode = `HTTP ${status || "network"} — upstream errors`;
      }
      const lpNote =
        isLpSource && severity === "error"
          ? " — LP fee/APR/cost basis могут ТИХО отсутствовать (инцидент POS-004/005)"
          : "";
      return {
        id: `upstream-unavailable:${r.provider}:${status}`,
        severity,
        category: "upstream-service-unavailable",
        message: `Provider '${r.provider}' — ${count}× HTTP ${status || "err"} за 24ч: ${mode}${lpNote}`,
        details: {
          provider: r.provider,
          httpStatus: status,
          count,
          missingKey: r.missing_key,
        },
      };
    });
  }

  /**
   * `duplicate_op_divergent_pricing` (C5b) — the same on-chain event
   * `(chain, tx_hash, log_index)` recorded under ≥2 wallets with divergent
   * USD. Root cause: `movement.usd` is priced at SYNC time, so an address
   * synced under two accounts at different times gets two values →
   * non-deterministic cost basis (POS-005). The real fix is Epic B1
   * (block-fixed pricing + registry dedup); this surfaces it meanwhile.
   * Spread `(max−min)/max` drives severity, thresholds shared with the pure
   * `findDivergentDuplicatePricing` so the two never drift.
   */
  private async duplicateOpDivergentPricing(): Promise<Finding[]> {
    const { warnPct, errorPct, minUsd } = DUPLICATE_PRICING_DEFAULTS;
    const rows = await this.db.execute<{
      chain: string;
      tx_hash: string;
      log_index: number;
      wallets: number;
      accounts: number;
      min_usd: string;
      max_usd: string;
      spread: string;
    }>(sql`
      WITH row_usd AS (
        SELECT co.wallet_id, w.account_id, co.chain, co.tx_hash, co.log_index,
               (SELECT COALESCE(SUM(ABS((m->>'usd')::numeric)), 0)
                FROM jsonb_array_elements(co.raw->'movement') m
                WHERE jsonb_typeof(m->'usd') = 'number') AS usd
        FROM chain_operations co
        JOIN wallets w ON w.id = co.wallet_id
        WHERE co.status <> 'failed'
      ),
      grp AS (
        SELECT chain, tx_hash, log_index,
               count(DISTINCT wallet_id) AS wallets,
               count(DISTINCT account_id) AS accounts,
               min(usd) AS min_usd, max(usd) AS max_usd
        FROM row_usd
        WHERE usd > ${minUsd}
        GROUP BY chain, tx_hash, log_index
        HAVING count(DISTINCT wallet_id) >= 2 AND max(usd) > 0
           AND (max(usd) - min(usd)) / max(usd) > ${warnPct}
      )
      SELECT chain, tx_hash, log_index, wallets, accounts, min_usd, max_usd,
             (max_usd - min_usd) / max_usd AS spread
      FROM grp
      ORDER BY spread DESC
      LIMIT 50
    `);
    return rows.rows.map((r) => {
      const spread = Number(r.spread);
      const minUsdV = Number(r.min_usd);
      const maxUsdV = Number(r.max_usd);
      return {
        id: `dup-op-pricing:${r.chain}:${r.tx_hash}:${r.log_index}`,
        severity: (spread > errorPct ? "error" : "warning") as FindingSeverity,
        category: "duplicate-op-divergent-pricing",
        message: `Один on-chain event priced по-разному: ${r.chain} ${r.tx_hash.slice(0, 12)}…#${r.log_index} — $${minUsdV.toFixed(2)}–$${maxUsdV.toFixed(2)} (расхождение ${(spread * 100).toFixed(1)}%), ${Number(r.wallets)} кош. / ${Number(r.accounts)} акк. — sync-time pricing (фикс = B1)`,
        details: {
          chain: r.chain,
          txHash: r.tx_hash,
          logIndex: Number(r.log_index),
          minUsd: minUsdV,
          maxUsd: maxUsdV,
          spreadPct: spread * 100,
          wallets: Number(r.wallets),
          accounts: Number(r.accounts),
          crossAccount: Number(r.accounts) > 1,
        },
      };
    });
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
