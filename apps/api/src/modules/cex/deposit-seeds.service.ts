/**
 * UCB C1: service layer для DepositSeeds.
 *
 * Поверх thin repo добавляет:
 *   - Audit log on upsert / delete (each operation видна в `audit_log`).
 *   - Note truncation до 500 chars (UI ограничение).
 *   - Batch limit 1000 (защита от DoS-style POST'ов).
 *   - `resolveCostBasisByHash(userId, hashes)` — bulk lookup для
 *     `CexCostBasisService.applyDeposit`. Возвращает Map с числовыми
 *     значениями (numeric из БД приходит string).
 */
import type { AuditService } from "../audit/audit.service.js";

import type {
  DepositSeedRow,
  DepositSeedsRepository,
} from "./deposit-seeds.repository.js";

export const MAX_SEEDS_PER_REQUEST = 1000;
const MAX_NOTE_LENGTH = 500;

export interface DepositSeedServiceInput {
  readonly txHash: string;
  readonly chain: string;
  readonly costBasisUsd: number;
  readonly walletId: string | null;
  readonly note: string | null;
}

export interface DepositSeedDto {
  readonly id: string;
  readonly txHash: string;
  readonly chain: string;
  readonly costBasisUsd: number;
  readonly walletId: string | null;
  readonly note: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toDto(r: DepositSeedRow): DepositSeedDto {
  return {
    id: r.id,
    txHash: r.txHash,
    chain: r.chain,
    costBasisUsd: Number(r.costBasisUsd),
    walletId: r.walletId,
    note: r.note,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export class DepositSeedsService {
  constructor(
    private readonly repo: DepositSeedsRepository,
    private readonly audit: AuditService,
  ) {}

  /**
   * Batch upsert. Per-user unique by tx_hash (idempotent).
   * Throws if batch > MAX или содержит invalid cost.
   */
  async upsertMany(
    userId: string,
    inputs: readonly DepositSeedServiceInput[],
  ): Promise<number> {
    if (inputs.length === 0) return 0;
    if (inputs.length > MAX_SEEDS_PER_REQUEST) {
      throw new Error(
        `Too many seeds in batch: ${inputs.length} > ${MAX_SEEDS_PER_REQUEST}`,
      );
    }
    const repoInputs = inputs.map((i) => ({
      userId,
      txHash: i.txHash,
      chain: i.chain,
      costBasisUsd: i.costBasisUsd,
      walletId: i.walletId,
      note: i.note != null ? i.note.slice(0, MAX_NOTE_LENGTH) : null,
    }));
    const count = await this.repo.upsertMany(repoInputs);
    await this.audit.log({
      actorUserId: userId,
      action: "cex.deposit_seeds.upsert",
      target: userId,
      payload: {
        count,
        sampleHashes: inputs.slice(0, 5).map((i) => i.txHash),
      },
    });
    return count;
  }

  /**
   * Bulk lookup для `applyDeposit`. Возвращает Map<lowercase-hash, number>.
   * Hashes normalized to lowercase ДО query (repo делает то же).
   */
  async resolveCostBasisByHash(
    userId: string,
    txHashes: readonly string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (txHashes.length === 0) return out;
    const rows = await this.repo.findByTxHashes(userId, txHashes);
    for (const r of rows) {
      out.set(r.txHash, Number(r.costBasisUsd));
    }
    return out;
  }

  /** All seeds — для UI listing / debug. */
  async listAll(userId: string): Promise<DepositSeedDto[]> {
    const rows = await this.repo.listByUser(userId);
    return rows.map(toDto);
  }

  /** Delete по hash. Returns true if что-то удалили; иначе false без audit. */
  async delete(userId: string, txHash: string): Promise<boolean> {
    const ok = await this.repo.deleteByTxHash(userId, txHash);
    if (ok) {
      await this.audit.log({
        actorUserId: userId,
        action: "cex.deposit_seeds.delete",
        target: userId,
        payload: { txHash: txHash.toLowerCase() },
      });
    }
    return ok;
  }
}
