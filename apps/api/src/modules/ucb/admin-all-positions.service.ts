/**
 * Admin global open-positions registry — every account's latest canonical
 * positions (ucb_shadow_results) in one flat list. Returns the FULL OpenPosition
 * objects (so the admin page renders the exact same column set as the user-facing
 * open-positions table via the shared getColumnCell), plus account/owner labels
 * and the open anomaly_flags overlaid per position (golden_case_drift +
 * invariants). Read-only over computed data → cheap; updates as the worker recomputes.
 */
import { type Database, schema } from "@cap-flow/db";
import { eq, sql } from "drizzle-orm";
import { positionKey } from "@cap-flow/ucb/identity";

export interface AllPositionAnomaly {
  checkId: string;
  severity: string;
  reason: string;
}

export interface AllPositionItem {
  accountId: string;
  ownerEmail: string | null;
  accountName: string | null;
  methodology: string;
  computedAt: string;
  /** Full OpenPosition object (the same shape the client renders). */
  position: unknown;
  anomalies: AllPositionAnomaly[];
  /** 'golden' = marked correct (эталон), 'wrong' = marked needs-fix, null = unmarked. */
  goldenKind: "golden" | "wrong" | null;
}

export class AdminAllPositionsService {
  constructor(private readonly db: Database) {}

  async list(): Promise<{ items: AllPositionItem[]; accounts: number; computedAt: string | null }> {
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

    // Golden overlay: active golden_cases keyed by positionKey → kind.
    const goldens = await this.db
      .select({
        positionKey: schema.goldenCases.positionKey,
        kind: schema.goldenCases.kind,
      })
      .from(schema.goldenCases)
      .where(eq(schema.goldenCases.status, "active"));
    const goldenByKey = new Map<string, "golden" | "wrong">();
    for (const g of goldens) {
      if (g.positionKey) goldenByKey.set(g.positionKey, g.kind as "golden" | "wrong");
    }

    let latestComputed: string | null = null;
    const items: AllPositionItem[] = [];
    /* eslint-disable @typescript-eslint/no-explicit-any */
    for (const acc of latest.rows) {
      const computedAt = acc.computed_at instanceof Date ? acc.computed_at.toISOString() : String(acc.computed_at);
      if (!latestComputed || computedAt > latestComputed) latestComputed = computedAt;
      const positions = Array.isArray(acc.positions) ? acc.positions : [];
      for (const p of positions as any[]) {
        const pid = String(p.id ?? "");
        let gKind: "golden" | "wrong" | null = null;
        try {
          gKind = goldenByKey.get(positionKey(p)) ?? null;
        } catch {
          gKind = null;
        }
        items.push({
          accountId: acc.account_id,
          ownerEmail: acc.owner_email,
          accountName: acc.account_name,
          methodology: acc.lot_methodology,
          computedAt,
          position: p,
          anomalies: flagsByKey.get(`${acc.account_id}|${pid}`) ?? [],
          goldenKind: gKind,
        });
      }
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
    return { items, accounts: latest.rows.length, computedAt: latestComputed };
  }
}
