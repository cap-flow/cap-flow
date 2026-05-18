/**
 * UCB C1: repository для cost-basis seeds CEX-депозитов.
 *
 * Контракт тонкий: insert / find / list / delete. Бизнес-валидация
 * (ownership, audit, normalization) — в service layer.
 *
 * Все tx_hashes ОБЯЗАТЕЛЬНО нормализуются к lowercase ДО insert/lookup —
 * без этого DB lookups vs client-stored hashes ломаются (EVM
 * stores как `0xABC...`, classifier даёт `0xabc...`).
 */
import { type Database, schema } from "@cap-flow/db";
import { and, eq, inArray, sql } from "drizzle-orm";

export type DepositSeedRow = typeof schema.cexDepositSeeds.$inferSelect;

export interface DepositSeedUpsertInput {
  readonly userId: string;
  readonly txHash: string;
  readonly chain: string;
  readonly costBasisUsd: number;
  readonly walletId: string | null;
  readonly note: string | null;
}

function normalizeHash(h: string): string {
  return h.toLowerCase();
}

export class DepositSeedsRepository {
  constructor(private readonly db: Database) {}

  /**
   * Upsert batch seeds. Per-user unique by tx_hash — повторный вызов
   * с тем же hash перезаписывает cost_basis_usd / chain / wallet_id / note.
   *
   * Возвращает count записанных строк (returning.length).
   * Pre-validates: costBasisUsd должен быть finite non-negative.
   */
  async upsertMany(inputs: readonly DepositSeedUpsertInput[]): Promise<number> {
    if (inputs.length === 0) return 0;

    // Validate batch — единая errored input должна fail всю операцию.
    for (const i of inputs) {
      if (!Number.isFinite(i.costBasisUsd) || i.costBasisUsd < 0) {
        throw new Error(
          `DepositSeed costBasisUsd must be non-negative finite number, got ${i.costBasisUsd} for tx ${i.txHash}`,
        );
      }
    }

    const values = inputs.map((i) => ({
      userId: i.userId,
      txHash: normalizeHash(i.txHash),
      chain: i.chain,
      costBasisUsd: String(i.costBasisUsd),
      walletId: i.walletId,
      note: i.note,
    }));

    const rows = await this.db
      .insert(schema.cexDepositSeeds)
      .values(values)
      .onConflictDoUpdate({
        target: [
          schema.cexDepositSeeds.userId,
          schema.cexDepositSeeds.txHash,
        ],
        set: {
          chain: sql`EXCLUDED.chain`,
          costBasisUsd: sql`EXCLUDED.cost_basis_usd`,
          walletId: sql`EXCLUDED.wallet_id`,
          note: sql`EXCLUDED.note`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: schema.cexDepositSeeds.id });
    return rows.length;
  }

  /** Batch find by tx hashes (lowercase before query). */
  async findByTxHashes(
    userId: string,
    txHashes: readonly string[],
  ): Promise<DepositSeedRow[]> {
    if (txHashes.length === 0) return [];
    const normalized = txHashes.map(normalizeHash);
    return this.db
      .select()
      .from(schema.cexDepositSeeds)
      .where(
        and(
          eq(schema.cexDepositSeeds.userId, userId),
          inArray(schema.cexDepositSeeds.txHash, normalized),
        ),
      );
  }

  /** All seeds для user'а (для UI listing / debugging). */
  async listByUser(userId: string): Promise<DepositSeedRow[]> {
    return this.db
      .select()
      .from(schema.cexDepositSeeds)
      .where(eq(schema.cexDepositSeeds.userId, userId));
  }

  /** Delete по (userId, txHash). Idempotent: returns true if удалено, false если не было. */
  async deleteByTxHash(userId: string, txHash: string): Promise<boolean> {
    const normalized = normalizeHash(txHash);
    const rows = await this.db
      .delete(schema.cexDepositSeeds)
      .where(
        and(
          eq(schema.cexDepositSeeds.userId, userId),
          eq(schema.cexDepositSeeds.txHash, normalized),
        ),
      )
      .returning({ id: schema.cexDepositSeeds.id });
    return rows.length > 0;
  }
}
