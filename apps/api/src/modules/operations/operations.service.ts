import { NotFoundError } from "../../core/errors.js";
import type { AccountsService } from "../accounts/accounts.service.js";
import type { AuditService } from "../audit/audit.service.js";
import type { AuthUser } from "../auth/auth.types.js";

import type {
  NewOperationRow,
  OperationRow,
  OperationsRepository,
} from "./operations.repository.js";

type Opt<T> = T | null | undefined;

export interface ImportBatchItem {
  readonly legacyId: string;
  readonly date: string; // YYYY-MM-DD
  readonly type: NewOperationRow["type"];
  readonly source?: NewOperationRow["source"] | undefined;
  readonly fromName?: Opt<string>;
  readonly toName?: Opt<string>;
  readonly cur1?: Opt<string>;
  readonly amount1?: Opt<string>;
  readonly cur2?: Opt<string>;
  readonly amount2?: Opt<string>;
  readonly rate?: Opt<string>;
  readonly avgPrice?: Opt<string>;
  readonly priceUsd?: Opt<string>;
  readonly posType?: Opt<string>;
  readonly funds?: NewOperationRow["funds"] | undefined;
  readonly loanRate?: Opt<string>;
  readonly loanRateTake?: Opt<string>;
  readonly loanFromName?: Opt<string>;
  readonly loanPosLegacyId?: Opt<string>;
  readonly loanLtv?: Opt<string>;
  readonly loanLiqPct?: Opt<string>;
  readonly loanLiqPrice?: Opt<string>;
  readonly loanCollateralUsd?: Opt<string>;
  readonly network?: Opt<string>;
  readonly commissionNetwork?: Opt<string>;
  readonly closeTokenAmount?: Opt<string>;
  readonly direction?: Opt<string>;
  readonly comment?: string | undefined;
}

/**
 * Operations management with tenant isolation.
 *
 * Audit entries: operations.import (batch summary),
 *               operations.deleted (per-row, when admin/user trims history).
 */
export class OperationsService {
  constructor(
    private readonly repo: OperationsRepository,
    private readonly accounts: AccountsService,
    private readonly audit: AuditService
  ) {}

  async list(
    accountId: string,
    actor: AuthUser,
    filter: {
      from?: string | undefined;
      to?: string | undefined;
      limit?: number | undefined;
      offset?: number | undefined;
    } = {}
  ): Promise<OperationRow[]> {
    await this.accounts.getById(accountId, actor);
    return this.repo.listByAccount({ accountId, ...filter });
  }

  async stats(
    accountId: string,
    actor: AuthUser
  ): Promise<{ count: number; lastUpdatedAt: Date | null }> {
    await this.accounts.getById(accountId, actor);
    const [count, lastUpdatedAt] = await Promise.all([
      this.repo.countByAccount(accountId),
      this.repo.lastUpdatedAt(accountId),
    ]);
    return { count, lastUpdatedAt };
  }

  async importBatch(
    accountId: string,
    items: ImportBatchItem[],
    actor: AuthUser
  ): Promise<{ inserted: number; updated: number; total: number }> {
    await this.accounts.getById(accountId, actor);

    const rows: NewOperationRow[] = items.map((i) => ({
      accountId,
      legacyId: i.legacyId,
      date: i.date,
      type: i.type,
      source: i.source ?? "import",
      fromName: i.fromName ?? null,
      toName: i.toName ?? null,
      cur1: i.cur1 ?? null,
      amount1: i.amount1 ?? null,
      cur2: i.cur2 ?? null,
      amount2: i.amount2 ?? null,
      rate: i.rate ?? null,
      avgPrice: i.avgPrice ?? null,
      priceUsd: i.priceUsd ?? null,
      posType: i.posType ?? null,
      funds: i.funds ?? null,
      loanRate: i.loanRate ?? null,
      loanRateTake: i.loanRateTake ?? null,
      loanFromName: i.loanFromName ?? null,
      loanPosLegacyId: i.loanPosLegacyId ?? null,
      loanLtv: i.loanLtv ?? null,
      loanLiqPct: i.loanLiqPct ?? null,
      loanLiqPrice: i.loanLiqPrice ?? null,
      loanCollateralUsd: i.loanCollateralUsd ?? null,
      network: i.network ?? null,
      commissionNetwork: i.commissionNetwork ?? null,
      closeTokenAmount: i.closeTokenAmount ?? null,
      direction: i.direction ?? null,
      comment: i.comment ?? "",
    }));

    const result = await this.repo.upsertBatch(rows);
    await this.audit.log({
      actorUserId: actor.id,
      accountId,
      action: "operations.import",
      payload: {
        inserted: result.inserted,
        updated: result.updated,
        total: rows.length,
      },
    });
    return { ...result, total: rows.length };
  }

  async deleteOne(
    accountId: string,
    operationId: string,
    actor: AuthUser
  ): Promise<void> {
    await this.accounts.getById(accountId, actor);
    const row = await this.repo.findById(operationId);
    if (!row || row.accountId !== accountId) {
      throw new NotFoundError(`Operation '${operationId}' not found.`);
    }
    const ok = await this.repo.delete(operationId);
    if (!ok) throw new NotFoundError(`Operation '${operationId}' not found.`);
    await this.audit.log({
      actorUserId: actor.id,
      accountId,
      action: "operations.deleted",
      payload: { operationId, legacyId: row.legacyId, type: row.type },
    });
  }
}
