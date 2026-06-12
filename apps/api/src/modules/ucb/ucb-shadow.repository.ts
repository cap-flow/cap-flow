/**
 * B5 — read/write path for the ucb_shadow_results sink. One repository serves
 * BOTH the worker write-path (insertResult) and the shadow-diff route
 * (findLatestForAccount + updateDiffSummary).
 *
 * The value-mapping cores (`toInsertValues`, `rowToShadowResult`) are pure and
 * unit-tested; the drizzle insert/select plumbing is thin and type-checked
 * against the schema (codebase style — api has no live-DB test harness).
 */
import { type Database, schema } from "@cap-flow/db";
import { desc, eq } from "drizzle-orm";

import type { OpenPosition } from "@cap-flow/ucb/open_positions";

import type { ShadowDiffSummary } from "./shadow-diff.js";
import type { StageRecord } from "./pipeline-trace.js";

export type UcbShadowTrigger = "refresh" | "manual" | "shadow_diff";

export interface UcbShadowWriteInput {
  accountId: string;
  trigger: UcbShadowTrigger;
  lotMethodology: string;
  positions: readonly OpenPosition[];
  engineVersion: string;
  /** Fail-soft: when the shadow compute threw (positions then []). */
  error?: string | null;
  diffSummary?: ShadowDiffSummary | null;
  /** Per-stage trace конвейера (pipeline-trace.ts); null у старых строк. */
  stages?: readonly StageRecord[] | null;
}

export interface UcbShadowResult {
  id: string;
  accountId: string;
  computedAt: Date;
  trigger: string;
  lotMethodology: string;
  positionCount: number;
  positions: OpenPosition[];
  engineVersion: string;
  diffSummary: ShadowDiffSummary | null;
  error: string | null;
  /** Optional — старые строки и тест-фикстуры без trace его не несут. */
  stages?: StageRecord[] | null;
}

type Row = typeof schema.ucbShadowResults.$inferSelect;
type InsertValues = typeof schema.ucbShadowResults.$inferInsert;

/** PURE: write-input → insert values. positionCount derived; nullables defaulted. */
export function toInsertValues(input: UcbShadowWriteInput): InsertValues {
  return {
    accountId: input.accountId,
    trigger: input.trigger,
    lotMethodology: input.lotMethodology,
    positionCount: input.positions.length,
    positions: input.positions,
    engineVersion: input.engineVersion,
    diffSummary: input.diffSummary ?? null,
    error: input.error ?? null,
    stages: input.stages ?? null,
  };
}

/** PURE: DB row → typed result (positions jsonb cast to OpenPosition[]). */
export function rowToShadowResult(row: Row): UcbShadowResult {
  return {
    id: row.id,
    accountId: row.accountId,
    computedAt: row.computedAt,
    trigger: row.trigger,
    lotMethodology: row.lotMethodology,
    positionCount: row.positionCount,
    positions: (row.positions ?? []) as OpenPosition[],
    engineVersion: row.engineVersion,
    diffSummary: (row.diffSummary ?? null) as ShadowDiffSummary | null,
    error: row.error ?? null,
    stages: (row.stages ?? null) as StageRecord[] | null,
  };
}

export class UcbShadowRepository {
  constructor(private readonly db: Database) {}

  async insertResult(input: UcbShadowWriteInput): Promise<{ id: string }> {
    const rows = await this.db
      .insert(schema.ucbShadowResults)
      .values(toInsertValues(input))
      .returning({ id: schema.ucbShadowResults.id });
    return { id: rows[0]!.id };
  }

  async findLatestForAccount(
    accountId: string,
  ): Promise<UcbShadowResult | null> {
    const rows = await this.db
      .select()
      .from(schema.ucbShadowResults)
      .where(eq(schema.ucbShadowResults.accountId, accountId))
      .orderBy(desc(schema.ucbShadowResults.computedAt))
      .limit(1);
    const row = rows[0];
    return row ? rowToShadowResult(row) : null;
  }

  async updateDiffSummary(
    id: string,
    diffSummary: ShadowDiffSummary,
  ): Promise<void> {
    await this.db
      .update(schema.ucbShadowResults)
      .set({ diffSummary })
      .where(eq(schema.ucbShadowResults.id, id));
  }
}
