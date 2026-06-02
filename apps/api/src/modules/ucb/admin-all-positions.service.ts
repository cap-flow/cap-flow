/**
 * Admin global open-positions registry — every account's latest canonical
 * positions (ucb_shadow_results) in one flat list, with the open anomaly_flags
 * overlaid per position (which already encode golden_case_drift + invariants).
 * Read-only over already-computed data → cheap; updates as the worker recomputes.
 */
import { type Database, schema } from "@cap-flow/db";
import { eq, sql } from "drizzle-orm";

export interface AllPositionAnomaly {
  checkId: string;
  severity: string;
  reason: string;
}

export interface AllPositionRow {
  accountId: string;
  ownerEmail: string | null;
  accountName: string | null;
  computedAt: string;
  methodology: string;
  positionId: string;
  chain: string;
  protocolId: string;
  symbol: string;
  matchedV3TokenId: string | null;
  startUsd: number;
  currentUsd: number;
  netPnlUsd: number;
  feesUsd: number | null;
  coverageIncomplete: boolean;
  anomalies: AllPositionAnomaly[];
}

export class AdminAllPositionsService {
  constructor(private readonly db: Database) {}

  async list(): Promise<{ positions: AllPositionRow[]; accounts: number; computedAt: string | null }> {
    // Latest shadow row per account + owner.
    const latest = await this.db.execute<{
      account_id: string;
      positions: unknown;
      computed_at: Date;
      lot_methodology: string;
      account_name: string | null;
      owner_email: string | null;
    }>(sql`
      SELECT DISTINCT ON (r.account_id)
        r.account_id, r.positions, r.computed_at, r.lot_methodology,
        a.name AS account_name, u.email AS owner_email
      FROM ${schema.ucbShadowResults} r
      JOIN ${schema.accounts} a ON a.id = r.account_id
      LEFT JOIN ${schema.users} u ON u.id = a.owner_id
      ORDER BY r.account_id, r.computed_at DESC
    `);

    // Open anomaly flags indexed by `${accountId}|${positionId}`.
    const flags = await this.db
      .select({
        accountId: schema.anomalyFlags.accountId,
        positionId: schema.anomalyFlags.positionId,
        checkId: schema.anomalyFlags.checkId,
        severity: schema.anomalyFlags.severity,
        detail: schema.anomalyFlags.detail,
      })
      .from(schema.anomalyFlags)
      .where(eq(schema.anomalyFlags.status, "open"));
    const flagsByKey = new Map<string, AllPositionAnomaly[]>();
    for (const f of flags) {
      const key = `${f.accountId}|${f.positionId ?? ""}`;
      const arr = flagsByKey.get(key) ?? [];
      arr.push({
        checkId: f.checkId,
        severity: f.severity,
        reason: String((f.detail as { reason?: string } | null)?.reason ?? ""),
      });
      flagsByKey.set(key, arr);
    }

    let latestComputed: string | null = null;
    const out: AllPositionRow[] = [];
    /* eslint-disable @typescript-eslint/no-explicit-any */
    for (const acc of latest.rows) {
      const computedAt = acc.computed_at instanceof Date ? acc.computed_at.toISOString() : String(acc.computed_at);
      if (!latestComputed || computedAt > latestComputed) latestComputed = computedAt;
      const positions = Array.isArray(acc.positions) ? acc.positions : [];
      for (const p of positions as any[]) {
        const pid = String(p.id ?? "");
        out.push({
          accountId: acc.account_id,
          ownerEmail: acc.owner_email,
          accountName: acc.account_name,
          computedAt,
          methodology: acc.lot_methodology,
          positionId: pid,
          chain: String(p.chain ?? ""),
          protocolId: String(p.protocol?.id ?? p.protocol?.name ?? ""),
          symbol: (p.supplyTokens ?? []).map((t: any) => t.symbol).join("+"),
          matchedV3TokenId: p.matchedV3TokenId ?? null,
          startUsd: Number(p.startUsd ?? 0),
          currentUsd: Number(p.currentUsd ?? 0),
          netPnlUsd: Number(p.netPnlUsd ?? 0),
          feesUsd: p.feesUsd == null ? null : Number(p.feesUsd),
          coverageIncomplete: Boolean(p.coverageIncomplete),
          anomalies: flagsByKey.get(`${acc.account_id}|${pid}`) ?? [],
        });
      }
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
    return { positions: out, accounts: latest.rows.length, computedAt: latestComputed };
  }
}
