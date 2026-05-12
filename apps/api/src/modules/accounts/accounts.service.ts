import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../core/errors.js";
import type { AuditService } from "../audit/audit.service.js";
import type { AuthUser } from "../auth/auth.types.js";

import type {
  AccountRow,
  CreateAccountInput,
  IAccountsRepository,
  UpdateAccountInput,
} from "./accounts.repository.js";

/**
 * Accounts service.
 *
 * Enforces the tenant model:
 *   - admin (or viewer with admin rights — not in MVP) can do anything
 *   - regular `user` may have at most 1 active account; the first one is also
 *     their `primary`
 *
 * All access checks happen here, on top of the route-level `requireAuth`.
 * Resource-scoped routes call `getAccountForUser` / `assertOwnerOrAdmin`
 * to enforce isolation in one place.
 */
export class AccountsService {
  constructor(
    private readonly repo: IAccountsRepository,
    private readonly audit: AuditService,
    private readonly options: { userAccountLimit: number } = {
      userAccountLimit: 1,
    }
  ) {}

  async listForCurrentUser(actor: AuthUser): Promise<AccountRow[]> {
    return this.repo.findActiveByOwner(actor.id);
  }

  /**
   * Admin convenience: list accounts of any user.
   * Caller must already have passed `requireAdmin`.
   */
  async listForUser(ownerId: string): Promise<AccountRow[]> {
    return this.repo.findActiveByOwner(ownerId);
  }

  async getById(id: string, actor: AuthUser): Promise<AccountRow> {
    const row = await this.repo.findById(id);
    if (!row || row.archivedAt) {
      throw new NotFoundError(`Account '${id}' not found.`);
    }
    this.assertOwnerOrAdmin(row, actor);
    return row;
  }

  async create(
    input: { name: string; description?: string | null },
    actor: AuthUser
  ): Promise<AccountRow> {
    const isAdmin = actor.role === "admin";

    if (!isAdmin) {
      const existing = await this.repo.countActiveByOwner(actor.id);
      if (existing >= this.options.userAccountLimit) {
        throw new ForbiddenError(
          `Account limit reached (${this.options.userAccountLimit} per user on beta).`
        );
      }
    }

    // First account becomes primary.
    const primary = await this.repo.findPrimaryByOwner(actor.id);
    const isPrimary = !primary;

    const created = await this.repo.create({
      ownerId: actor.id,
      name: input.name,
      description: input.description ?? null,
      isPrimary,
    } satisfies CreateAccountInput);

    await this.audit.log({
      actorUserId: actor.id,
      action: "account.created",
      accountId: created.id,
      payload: { name: created.name, isPrimary: created.isPrimary },
    });

    return created;
  }

  async update(
    id: string,
    patch: UpdateAccountInput,
    actor: AuthUser
  ): Promise<AccountRow> {
    const account = await this.repo.findById(id);
    if (!account || account.archivedAt) {
      throw new NotFoundError(`Account '${id}' not found.`);
    }
    this.assertOwnerOrAdmin(account, actor);

    const updated = await this.repo.update(id, patch);
    if (!updated) throw new NotFoundError(`Account '${id}' not found.`);

    await this.audit.log({
      actorUserId: actor.id,
      asAdmin: actor.role === "admin" && account.ownerId !== actor.id,
      targetUserId: account.ownerId,
      accountId: id,
      action: "account.updated",
      payload: { patch },
    });

    return updated;
  }

  async archive(id: string, actor: AuthUser): Promise<AccountRow> {
    const account = await this.repo.findById(id);
    if (!account || account.archivedAt) {
      throw new NotFoundError(`Account '${id}' not found.`);
    }
    this.assertOwnerOrAdmin(account, actor);

    if (account.isPrimary && actor.role !== "admin") {
      throw new ConflictError("Primary account cannot be archived by user.");
    }

    const archived = await this.repo.archive(id, new Date());
    if (!archived) throw new NotFoundError(`Account '${id}' not found.`);

    await this.audit.log({
      actorUserId: actor.id,
      asAdmin: actor.role === "admin" && account.ownerId !== actor.id,
      targetUserId: account.ownerId,
      accountId: id,
      action: "account.archived",
    });

    return archived;
  }

  // ─── tenant-isolation helpers (used by middleware too) ──────────────

  /** Throws ForbiddenError if `actor` is neither the owner nor an admin. */
  assertOwnerOrAdmin(account: AccountRow, actor: AuthUser): void {
    if (actor.role === "admin") return;
    if (account.ownerId !== actor.id) {
      // Return Forbidden — not NotFound — only after we already confirmed the
      // row exists. Routes that find-then-assert are safe; if you assert on
      // an unknown id you'd leak existence. Callers should `findById` first.
      throw new ForbiddenError("You do not have access to this account.");
    }
  }
}
