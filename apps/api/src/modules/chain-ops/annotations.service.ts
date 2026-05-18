/**
 * UCB A3: service-layer для per-op annotations.
 *
 * Ownership-checks: пользователь может аннотировать только ops в своих
 * wallets (через chain_operations.wallet_id → wallets.account_id →
 * accounts.owner_id). Все mutate-методы проверяют это через
 * `walletBelongsToUser` helper.
 *
 * Также аудитом записываем — annotation = пользовательское решение,
 * влияющее на cost basis ↔ должно остаться в логе.
 */
import { type Database, schema } from "@cap-flow/db";
import { and, eq } from "drizzle-orm";

import { ForbiddenError, NotFoundError } from "../../core/errors.js";
import type { AuditService } from "../audit/audit.service.js";

import {
  type AnnotationRow,
  AnnotationsRepository,
  type AnnotationUpsertInput,
} from "./annotations.repository.js";

export interface AnnotationServiceInput {
  readonly isInternalTransfer: boolean | null;
  readonly manualCostBasisUsd: number | null;
  readonly manualOpType: string | null;
  readonly note: string | null;
  /** UCB D8: soft-delete. true = UCB pipeline ignores this op. Optional. */
  readonly excluded?: boolean;
}

export class AnnotationsService {
  constructor(
    private readonly db: Database,
    private readonly repo: AnnotationsRepository,
    private readonly audit: AuditService,
  ) {}

  /**
   * Verify, что op принадлежит wallet'у этого user'а. Возвращает true,
   * либо throws ForbiddenError. Используется во всех mutate-методах.
   *
   * Чейн ownership: chain_operations → wallets → accounts → owner_id.
   */
  private async ensureOwnership(
    chainOpId: string,
    userId: string,
  ): Promise<void> {
    const rows = await this.db
      .select({ id: schema.chainOperations.id })
      .from(schema.chainOperations)
      .innerJoin(
        schema.wallets,
        eq(schema.wallets.id, schema.chainOperations.walletId),
      )
      .innerJoin(
        schema.accounts,
        eq(schema.accounts.id, schema.wallets.accountId),
      )
      .where(
        and(
          eq(schema.chainOperations.id, chainOpId),
          eq(schema.accounts.ownerId, userId),
        ),
      )
      .limit(1);
    if (rows.length === 0) {
      throw new ForbiddenError(`Operation ${chainOpId} not accessible.`);
    }
  }

  /**
   * Resolve composite key (walletId, txHash, logIndex) → chain_operations.id.
   * Через ownership chain — wallet должен принадлежать user'у. Возвращает
   * null если такого op нет ИЛИ wallet не user'а (одинаковая ошибка с
   * security-стороны).
   */
  async resolveChainOpIdByKey(
    walletId: string,
    txHash: string,
    logIndex: number,
    userId: string,
  ): Promise<string | null> {
    const rows = await this.db
      .select({ id: schema.chainOperations.id })
      .from(schema.chainOperations)
      .innerJoin(
        schema.wallets,
        eq(schema.wallets.id, schema.chainOperations.walletId),
      )
      .innerJoin(
        schema.accounts,
        eq(schema.accounts.id, schema.wallets.accountId),
      )
      .where(
        and(
          eq(schema.chainOperations.walletId, walletId),
          eq(schema.chainOperations.txHash, txHash),
          eq(schema.chainOperations.logIndex, logIndex),
          eq(schema.accounts.ownerId, userId),
        ),
      )
      .limit(1);
    return rows[0]?.id ?? null;
  }

  /** Upsert by composite key — first-create flow для не-аннотированного op. */
  async upsertByKey(
    walletId: string,
    txHash: string,
    logIndex: number,
    userId: string,
    input: AnnotationServiceInput,
  ): Promise<AnnotationRow> {
    const chainOpId = await this.resolveChainOpIdByKey(
      walletId,
      txHash,
      logIndex,
      userId,
    );
    if (!chainOpId) {
      throw new ForbiddenError(
        `Operation (${walletId}, ${txHash}, ${logIndex}) not found or not accessible.`,
      );
    }
    return this.upsert(chainOpId, userId, input);
  }

  async upsert(
    chainOpId: string,
    userId: string,
    input: AnnotationServiceInput,
  ): Promise<AnnotationRow> {
    await this.ensureOwnership(chainOpId, userId);

    // Validation: manualCostBasisUsd должен быть positive или null.
    if (
      input.manualCostBasisUsd != null &&
      (!Number.isFinite(input.manualCostBasisUsd) ||
        input.manualCostBasisUsd < 0)
    ) {
      throw new NotFoundError(
        `manualCostBasisUsd must be non-negative finite number, got ${input.manualCostBasisUsd}`,
      );
    }
    // Validation: manualOpType — фиксированный whitelist чтобы юзер не
    // ввёл мусор, ломающий downstream classifier-aware code paths.
    if (input.manualOpType != null) {
      const allowed = new Set([
        "transfer_in",
        "transfer_out",
        "bridge_in",
        "bridge_out",
        "deposit_fiat",
        "withdraw_fiat",
        "swap",
        "lend_supply",
        "lend_withdraw",
        "borrow",
        "repay",
        "lp_add",
        "lp_remove",
        "claim_rewards",
        "approve",
        "unknown",
      ]);
      if (!allowed.has(input.manualOpType)) {
        throw new NotFoundError(`manualOpType "${input.manualOpType}" invalid.`);
      }
    }

    const upsertInput: AnnotationUpsertInput = {
      chainOpId,
      userId,
      isInternalTransfer: input.isInternalTransfer,
      manualCostBasisUsd: input.manualCostBasisUsd,
      manualOpType: input.manualOpType,
      // Truncate note до 2000 chars — UI ограничение.
      note: input.note?.slice(0, 2000) ?? null,
      excluded: input.excluded === true,
    };
    const row = await this.repo.upsert(upsertInput);

    await this.audit.log({
      actorUserId: userId,
      action: "chain_ops.annotation.upsert",
      target: chainOpId,
      payload: {
        isInternalTransfer: input.isInternalTransfer,
        manualCostBasisUsd: input.manualCostBasisUsd,
        manualOpType: input.manualOpType,
        hasNote: !!input.note,
        excluded: input.excluded === true,
      },
    });
    return row;
  }

  async delete(chainOpId: string, userId: string): Promise<void> {
    await this.ensureOwnership(chainOpId, userId);
    const removed = await this.repo.deleteByOp(chainOpId, userId);
    if (removed > 0) {
      await this.audit.log({
        actorUserId: userId,
        action: "chain_ops.annotation.delete",
        target: chainOpId,
      });
    }
  }

  /**
   * All annotations user'а — для UI-bulk load. Resolved variant возвращает
   * также txHash + walletId + logIndex, чтобы client мог merge annotations
   * с ops по composite key без extra round-trip.
   */
  async listAll(userId: string): Promise<
    (AnnotationRow & {
      readonly txHash: string;
      readonly walletId: string;
      readonly logIndex: number;
    })[]
  > {
    return this.repo.listByUserResolved(userId);
  }
}
