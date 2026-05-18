/**
 * UCB A3: repository для per-op user annotations.
 *
 * Контракт thin'овский — annotation rows немного, индекс на (op, user),
 * запросы простые. Логика "что значит каждое override-поле" живёт в
 * service-layer (применение к raw, валидация).
 */
import { type Database, schema } from "@cap-flow/db";
import { and, eq, inArray, sql } from "drizzle-orm";

export type AnnotationRow = typeof schema.chainOperationAnnotations.$inferSelect;

export interface AnnotationUpsertInput {
  readonly chainOpId: string;
  readonly userId: string;
  readonly isInternalTransfer: boolean | null;
  readonly manualCostBasisUsd: number | null;
  readonly manualOpType: string | null;
  readonly note: string | null;
  /** UCB D8: soft-delete flag. */
  readonly excluded: boolean;
}

export class AnnotationsRepository {
  constructor(private readonly db: Database) {}

  /**
   * Upsert annotation для (op, user) — один user может аннотировать только
   * один и тот же op один раз, повторные PUT перезаписывают существующее.
   * Если все override-поля null — это всё равно валидно (user может
   * существенно хранить только note).
   */
  async upsert(input: AnnotationUpsertInput): Promise<AnnotationRow> {
    const [row] = await this.db
      .insert(schema.chainOperationAnnotations)
      .values({
        chainOpId: input.chainOpId,
        userId: input.userId,
        isInternalTransfer: input.isInternalTransfer,
        // Drizzle numeric — string-typed для сохранения precision. Конвертим
        // только если non-null.
        manualCostBasisUsd:
          input.manualCostBasisUsd != null
            ? String(input.manualCostBasisUsd)
            : null,
        manualOpType: input.manualOpType,
        note: input.note,
        excluded: input.excluded,
      })
      .onConflictDoUpdate({
        target: [
          schema.chainOperationAnnotations.chainOpId,
          schema.chainOperationAnnotations.userId,
        ],
        set: {
          isInternalTransfer: sql`EXCLUDED.is_internal_transfer`,
          manualCostBasisUsd: sql`EXCLUDED.manual_cost_basis_usd`,
          manualOpType: sql`EXCLUDED.manual_op_type`,
          note: sql`EXCLUDED.note`,
          excluded: sql`EXCLUDED.excluded`,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    if (!row) throw new Error("upsert annotation returned no row");
    return row;
  }

  /**
   * Удалить annotation. Идемпотент: если нет — просто 0 affected, не throw.
   */
  async deleteByOp(chainOpId: string, userId: string): Promise<number> {
    const rows = await this.db
      .delete(schema.chainOperationAnnotations)
      .where(
        and(
          eq(schema.chainOperationAnnotations.chainOpId, chainOpId),
          eq(schema.chainOperationAnnotations.userId, userId),
        ),
      )
      .returning({ id: schema.chainOperationAnnotations.id });
    return rows.length;
  }

  /** Single annotation (для check ownership / view current state). */
  async getByOp(
    chainOpId: string,
    userId: string,
  ): Promise<AnnotationRow | null> {
    const rows = await this.db
      .select()
      .from(schema.chainOperationAnnotations)
      .where(
        and(
          eq(schema.chainOperationAnnotations.chainOpId, chainOpId),
          eq(schema.chainOperationAnnotations.userId, userId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * List все annotations user'а в один запрос — UI применяет их
   * к ops в памяти, не дёргает endpoint per op.
   */
  async listByUser(userId: string): Promise<AnnotationRow[]> {
    return this.db
      .select()
      .from(schema.chainOperationAnnotations)
      .where(eq(schema.chainOperationAnnotations.userId, userId));
  }

  /**
   * Same as `listByUser`, но JOIN'им chain_operations чтобы client мог
   * match'ить annotations по (txHash, walletId, logIndex) — стабильным
   * идентификаторам ClassifiedOp, а не по серверному chain_op_id.
   *
   * Это убирает round-trip "resolve chain_op_id → composite key" и
   * упрощает client-side merge.
   */
  async listByUserResolved(userId: string): Promise<
    (AnnotationRow & {
      readonly txHash: string;
      readonly walletId: string;
      readonly logIndex: number;
    })[]
  > {
    return this.db
      .select({
        id: schema.chainOperationAnnotations.id,
        chainOpId: schema.chainOperationAnnotations.chainOpId,
        userId: schema.chainOperationAnnotations.userId,
        isInternalTransfer:
          schema.chainOperationAnnotations.isInternalTransfer,
        manualCostBasisUsd:
          schema.chainOperationAnnotations.manualCostBasisUsd,
        manualOpType: schema.chainOperationAnnotations.manualOpType,
        note: schema.chainOperationAnnotations.note,
        excluded: schema.chainOperationAnnotations.excluded,
        createdAt: schema.chainOperationAnnotations.createdAt,
        updatedAt: schema.chainOperationAnnotations.updatedAt,
        txHash: schema.chainOperations.txHash,
        walletId: schema.chainOperations.walletId,
        logIndex: schema.chainOperations.logIndex,
      })
      .from(schema.chainOperationAnnotations)
      .innerJoin(
        schema.chainOperations,
        eq(
          schema.chainOperations.id,
          schema.chainOperationAnnotations.chainOpId,
        ),
      )
      .where(eq(schema.chainOperationAnnotations.userId, userId));
  }

  /**
   * Batch fetch для конкретного набора ops (когда client запрашивает
   * только видимые ops, не all). Возвращает map (chainOpId → annotation).
   */
  async listByOpIds(
    chainOpIds: readonly string[],
    userId: string,
  ): Promise<AnnotationRow[]> {
    if (chainOpIds.length === 0) return [];
    return this.db
      .select()
      .from(schema.chainOperationAnnotations)
      .where(
        and(
          inArray(schema.chainOperationAnnotations.chainOpId, [...chainOpIds]),
          eq(schema.chainOperationAnnotations.userId, userId),
        ),
      );
  }
}
