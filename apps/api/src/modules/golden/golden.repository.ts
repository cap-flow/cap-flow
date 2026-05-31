/**
 * UCB Epic A3: repository for golden_cases + anomaly_flags (admin-only).
 *
 * Golden cases are the per-position EXPECTED-OUTPUT oracle (the regression
 * anchor); anomaly flags are detector findings. Both are admin-curated —
 * there is NO per-user surface (see plan Q6). `walletId`/`accountId` identify
 * the subject being curated, not an owner.
 *
 * Numeric columns are Drizzle `numeric` → string-typed to preserve precision;
 * the route layer converts to/from `number` at the wire boundary.
 */
import { type Database, schema } from "@cap-flow/db";
import { and, desc, eq, isNotNull } from "drizzle-orm";

export type GoldenCaseRow = typeof schema.goldenCases.$inferSelect;
export type AnomalyFlagRow = typeof schema.anomalyFlags.$inferSelect;

export interface GoldenCaseInsert {
  readonly walletId: string;
  readonly positionId: string;
  /** A3.6 stable global identity (see @cap-flow/ucb positionKey). */
  readonly positionKey: string | null;
  readonly chain: string;
  readonly protocolId: string;
  readonly marketKey: string | null;
  readonly openHash: string | null;
  readonly label: string;
  readonly kind: "golden" | "wrong";
  readonly issue: string | null;
  readonly expectedStartUsd: number | null;
  readonly expectedNetStartUsd: number | null;
  readonly expectedPnlUsd: number | null;
  readonly toleranceAbsUsd: number;
  readonly tolerancePct: number;
  readonly sourceOfTruth: string;
  readonly provenanceNote: string | null;
  readonly methodologyVersion: string;
  readonly fixturePath: string | null;
  /** A3.6 knowledge base: ops + cost-flow trace (jsonb). */
  readonly derivation: unknown;
  readonly createdByUserId: string | null;
  readonly promotedFromAnomalyId: string | null;
}

export interface GoldenCasePatch {
  readonly expectedStartUsd?: number | null | undefined;
  readonly expectedNetStartUsd?: number | null | undefined;
  readonly expectedPnlUsd?: number | null | undefined;
  readonly toleranceAbsUsd?: number | undefined;
  readonly tolerancePct?: number | undefined;
  readonly provenanceNote?: string | null | undefined;
  readonly methodologyVersion?: string | undefined;
  readonly fixturePath?: string | null | undefined;
  readonly status?: string | undefined;
}

const num = (n: number | null | undefined): string | null | undefined =>
  n == null ? n : String(n);

export class GoldenRepository {
  constructor(private readonly db: Database) {}

  // ── golden_cases ────────────────────────────────────────────────────

  /**
   * Upsert by (walletId, positionId) — re-marking a position UPDATES its
   * golden case rather than violating the unique constraint (fixes the 500
   * on re-mark). Marking is idempotent.
   */
  async createGolden(input: GoldenCaseInsert): Promise<GoldenCaseRow> {
    const values = {
      walletId: input.walletId,
      positionId: input.positionId,
      positionKey: input.positionKey,
      chain: input.chain,
      protocolId: input.protocolId,
      marketKey: input.marketKey,
      openHash: input.openHash,
      label: input.label,
      kind: input.kind,
      issue: input.issue,
      expectedStartUsd: num(input.expectedStartUsd) ?? null,
      expectedNetStartUsd: num(input.expectedNetStartUsd) ?? null,
      expectedPnlUsd: num(input.expectedPnlUsd) ?? null,
      toleranceAbsUsd: String(input.toleranceAbsUsd),
      tolerancePct: String(input.tolerancePct),
      sourceOfTruth: input.sourceOfTruth,
      provenanceNote: input.provenanceNote,
      methodologyVersion: input.methodologyVersion,
      fixturePath: input.fixturePath,
      derivation: input.derivation ?? null,
      createdByUserId: input.createdByUserId,
      promotedFromAnomalyId: input.promotedFromAnomalyId,
    };
    const [row] = await this.db
      .insert(schema.goldenCases)
      .values(values)
      .onConflictDoUpdate({
        // A3.6: identity is the stable positionKey, not (wallet, positionId).
        target: schema.goldenCases.positionKey,
        // The unique index is PARTIAL (WHERE position_key IS NOT NULL); the
        // ON CONFLICT target MUST repeat that predicate or Postgres can't match
        // the index (error 42P10 → 500 on save). See migration 0028.
        targetWhere: isNotNull(schema.goldenCases.positionKey),
        set: {
          positionId: values.positionId,
          label: values.label,
          kind: values.kind,
          issue: values.issue,
          chain: values.chain,
          protocolId: values.protocolId,
          marketKey: values.marketKey,
          openHash: values.openHash,
          expectedStartUsd: values.expectedStartUsd,
          expectedNetStartUsd: values.expectedNetStartUsd,
          expectedPnlUsd: values.expectedPnlUsd,
          toleranceAbsUsd: values.toleranceAbsUsd,
          tolerancePct: values.tolerancePct,
          sourceOfTruth: values.sourceOfTruth,
          provenanceNote: values.provenanceNote,
          methodologyVersion: values.methodologyVersion,
          derivation: values.derivation,
          status: "active",
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!row) throw new Error("createGolden returned no row");
    return row;
  }

  async listGolden(filter: { walletId?: string }): Promise<GoldenCaseRow[]> {
    const where = filter.walletId
      ? eq(schema.goldenCases.walletId, filter.walletId)
      : undefined;
    const q = this.db.select().from(schema.goldenCases);
    return (where ? q.where(where) : q).orderBy(desc(schema.goldenCases.createdAt));
  }

  async getGolden(id: string): Promise<GoldenCaseRow | null> {
    const rows = await this.db
      .select()
      .from(schema.goldenCases)
      .where(eq(schema.goldenCases.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async patchGolden(
    id: string,
    patch: GoldenCasePatch,
  ): Promise<GoldenCaseRow | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if ("expectedStartUsd" in patch) set.expectedStartUsd = num(patch.expectedStartUsd);
    if ("expectedNetStartUsd" in patch) set.expectedNetStartUsd = num(patch.expectedNetStartUsd);
    if ("expectedPnlUsd" in patch) set.expectedPnlUsd = num(patch.expectedPnlUsd);
    if (patch.toleranceAbsUsd != null) set.toleranceAbsUsd = String(patch.toleranceAbsUsd);
    if (patch.tolerancePct != null) set.tolerancePct = String(patch.tolerancePct);
    if ("provenanceNote" in patch) set.provenanceNote = patch.provenanceNote;
    if (patch.methodologyVersion != null) set.methodologyVersion = patch.methodologyVersion;
    if ("fixturePath" in patch) set.fixturePath = patch.fixturePath;
    if (patch.status != null) set.status = patch.status;
    const [row] = await this.db
      .update(schema.goldenCases)
      .set(set)
      .where(eq(schema.goldenCases.id, id))
      .returning();
    return row ?? null;
  }

  // ── anomaly_flags ───────────────────────────────────────────────────

  async listAnomalies(filter: {
    status?: string;
    walletId?: string;
  }): Promise<AnomalyFlagRow[]> {
    const preds = [];
    if (filter.status) preds.push(eq(schema.anomalyFlags.status, filter.status));
    if (filter.walletId) preds.push(eq(schema.anomalyFlags.walletId, filter.walletId));
    const q = this.db.select().from(schema.anomalyFlags);
    const filtered = preds.length > 0 ? q.where(and(...preds)) : q;
    return filtered.orderBy(desc(schema.anomalyFlags.lastSeenAt));
  }

  async getAnomaly(id: string): Promise<AnomalyFlagRow | null> {
    const rows = await this.db
      .select()
      .from(schema.anomalyFlags)
      .where(eq(schema.anomalyFlags.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async patchAnomaly(
    id: string,
    patch: { status?: string; resolvedNote?: string | null; resolvedAt?: Date | null },
  ): Promise<AnomalyFlagRow | null> {
    const set: Record<string, unknown> = {};
    if (patch.status != null) set.status = patch.status;
    if ("resolvedNote" in patch) set.resolvedNote = patch.resolvedNote;
    if ("resolvedAt" in patch) set.resolvedAt = patch.resolvedAt;
    const [row] = await this.db
      .update(schema.anomalyFlags)
      .set(set)
      .where(eq(schema.anomalyFlags.id, id))
      .returning();
    return row ?? null;
  }

  /**
   * Promote an anomaly to a golden case in one transaction: insert the golden
   * row, then mark the anomaly `promoted` with a bidirectional link. The
   * learning loop that closes the 3× recurrence problem.
   */
  async promoteAnomaly(
    anomalyId: string,
    golden: GoldenCaseInsert,
  ): Promise<{ golden: GoldenCaseRow; anomaly: AnomalyFlagRow }> {
    return this.db.transaction(async (tx) => {
      const [g] = await tx
        .insert(schema.goldenCases)
        .values({
          walletId: golden.walletId,
          positionId: golden.positionId,
          positionKey: golden.positionKey,
          chain: golden.chain,
          protocolId: golden.protocolId,
          marketKey: golden.marketKey,
          openHash: golden.openHash,
          label: golden.label,
          kind: golden.kind,
          issue: golden.issue,
          expectedStartUsd: num(golden.expectedStartUsd) ?? null,
          expectedNetStartUsd: num(golden.expectedNetStartUsd) ?? null,
          expectedPnlUsd: num(golden.expectedPnlUsd) ?? null,
          toleranceAbsUsd: String(golden.toleranceAbsUsd),
          tolerancePct: String(golden.tolerancePct),
          sourceOfTruth: golden.sourceOfTruth,
          provenanceNote: golden.provenanceNote,
          methodologyVersion: golden.methodologyVersion,
          fixturePath: golden.fixturePath,
          derivation: golden.derivation ?? null,
          createdByUserId: golden.createdByUserId,
          promotedFromAnomalyId: anomalyId,
        })
        .returning();
      if (!g) throw new Error("promoteAnomaly: golden insert returned no row");
      const [a] = await tx
        .update(schema.anomalyFlags)
        .set({ status: "promoted", goldenCaseId: g.id, resolvedAt: new Date() })
        .where(eq(schema.anomalyFlags.id, anomalyId))
        .returning();
      if (!a) throw new Error("promoteAnomaly: anomaly not found");
      return { golden: g, anomaly: a };
    });
  }
}
