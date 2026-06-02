/**
 * Epic C — anomaly_flags write path. One row per idempotency key
 * (accountId, walletId, positionId, checkId) NULLS NOT DISTINCT: a still-tripping
 * finding bumps lastSeenAt + refreshes the payload; a finding that stopped
 * tripping is auto-resolved. Account-scoped (tenant isolation).
 */
import { type Database, schema } from "@cap-flow/db";
import { and, eq, inArray } from "drizzle-orm";

import type { AnomalyFinding } from "./checks.js";

export type AnomalyFlagRow = typeof schema.anomalyFlags.$inferSelect;

const num = (n: number | null | undefined): string | null =>
  n == null ? null : String(n);

/** Idempotency key within an account (matches the unique index minus accountId). */
export function findingKey(f: {
  walletId?: string | null;
  positionId?: string | null;
  checkId: string;
}): string {
  return `${f.walletId ?? ""}|${f.positionId ?? ""}|${f.checkId}`;
}

export class AnomalyFlagsRepository {
  constructor(private readonly db: Database) {}

  /** Upsert one finding (insert or re-open + bump lastSeenAt + refresh payload). */
  async upsert(
    accountId: string,
    f: AnomalyFinding,
    detectorVersion: string,
    now: Date = new Date(),
  ): Promise<void> {
    await this.db
      .insert(schema.anomalyFlags)
      .values({
        accountId,
        walletId: f.walletId ?? null,
        positionId: f.positionId ?? null,
        chain: f.chain ?? null,
        protocolId: f.protocolId ?? null,
        marketKey: f.marketKey ?? null,
        checkId: f.checkId,
        anomalyType: f.anomalyType,
        severity: f.severity,
        phase: f.phase,
        observedValue: num(f.observedValue),
        expectedValue: num(f.expectedValue),
        detail: f.detail,
        goldenCaseId: f.goldenCaseId ?? null,
        status: "open",
        detectorVersion,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.anomalyFlags.accountId,
          schema.anomalyFlags.walletId,
          schema.anomalyFlags.positionId,
          schema.anomalyFlags.checkId,
        ],
        set: {
          severity: f.severity,
          anomalyType: f.anomalyType,
          phase: f.phase,
          chain: f.chain ?? null,
          protocolId: f.protocolId ?? null,
          marketKey: f.marketKey ?? null,
          observedValue: num(f.observedValue),
          expectedValue: num(f.expectedValue),
          detail: f.detail,
          goldenCaseId: f.goldenCaseId ?? null,
          detectorVersion,
          lastSeenAt: now,
          // Re-open a previously-resolved flag that is tripping again.
          status: "open",
          resolvedAt: null,
          resolvedNote: null,
        },
      });
  }

  async upsertMany(
    accountId: string,
    findings: readonly AnomalyFinding[],
    detectorVersion: string,
    now: Date = new Date(),
  ): Promise<void> {
    for (const f of findings) await this.upsert(accountId, f, detectorVersion, now);
  }

  /**
   * Auto-resolve open flags of this account whose key is NOT in the currently-
   * tripping set (the finding stopped firing). Returns the number resolved.
   */
  async autoResolveStale(
    accountId: string,
    trippingKeys: ReadonlySet<string>,
    now: Date = new Date(),
  ): Promise<number> {
    const open = await this.db
      .select({
        id: schema.anomalyFlags.id,
        walletId: schema.anomalyFlags.walletId,
        positionId: schema.anomalyFlags.positionId,
        checkId: schema.anomalyFlags.checkId,
      })
      .from(schema.anomalyFlags)
      .where(
        and(
          eq(schema.anomalyFlags.accountId, accountId),
          eq(schema.anomalyFlags.status, "open"),
        ),
      );
    const staleIds = open
      .filter((o) => !trippingKeys.has(findingKey(o)))
      .map((o) => o.id);
    if (staleIds.length === 0) return 0;
    await this.db
      .update(schema.anomalyFlags)
      .set({ status: "resolved", resolvedAt: now, resolvedNote: "auto: no longer tripping" })
      .where(inArray(schema.anomalyFlags.id, staleIds));
    return staleIds.length;
  }

  async list(filter: {
    accountId?: string;
    walletId?: string;
    status?: string;
  }): Promise<AnomalyFlagRow[]> {
    const conds = [];
    if (filter.accountId) conds.push(eq(schema.anomalyFlags.accountId, filter.accountId));
    if (filter.walletId) conds.push(eq(schema.anomalyFlags.walletId, filter.walletId));
    if (filter.status) conds.push(eq(schema.anomalyFlags.status, filter.status));
    const q = this.db.select().from(schema.anomalyFlags);
    return conds.length > 0 ? q.where(and(...conds)) : q;
  }
}
