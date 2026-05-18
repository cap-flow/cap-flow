import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../core/errors.js";
import type { AuditService } from "../audit/audit.service.js";
import type { AuthUser } from "../auth/auth.types.js";
import type { PortfolioRefreshQueue } from "../queue/portfolio-refresh.queue.js";

import type {
  AccountRow,
  CreateAccountInput,
  IAccountsRepository,
  UpdateAccountInput,
} from "./accounts.repository.js";

/**
 * Cron-cadence для авто-refresh новых аккаунтов. Совпадает с константами
 * в worker.ts — keep in sync.
 */
const NEW_ACCOUNT_REFRESH_EVERY_MS = 60 * 60 * 1000; // 1 hour
const NEW_ACCOUNT_REFRESH_JITTER_MS = 5 * 60 * 1000; // 5 min spread

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
    },
    /**
     * Опциональная очередь для cron-refresh. Если задана — при создании
     * нового аккаунта мы сразу регистрируем recurring refresh, чтобы
     * пользователь видел снапшоты без ожидания рестарта worker'а
     * (без этого новый аккаунт получит cron только при следующем
     * worker bootstrap'е, что для via.irk@gmail.com обернулось
     * пустой строкой в admin/portfolios).
     */
    private readonly refreshQueue?: PortfolioRefreshQueue
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

    // Schedule recurring refresh + fire one immediate manual refresh.
    // Без этого первый снапшот придёт только через 1 час (cron), а в
    // admin/portfolios строка будет «TVL —» до тех пор.
    if (this.refreshQueue) {
      try {
        await this.refreshQueue.scheduleRecurring(created.id, {
          everyMs: NEW_ACCOUNT_REFRESH_EVERY_MS,
          jitterMs: NEW_ACCOUNT_REFRESH_JITTER_MS,
        });
        await this.refreshQueue.enqueueManual(
          created.id,
          actor.id,
          actor.role === "admin" ? "admin" : "user"
        );
      } catch (e) {
        // Не фейлим create — кэш / расписание восстановятся при
        // следующем worker bootstrap'е.
        // eslint-disable-next-line no-console
        console.warn(
          `[accounts.service] failed to schedule refresh for new account ${created.id}:`,
          e
        );
      }
    }

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

  /**
   * M1 (2026-05-14): throws **NotFoundError** (not Forbidden) when caller
   * isn't the owner — collapses the response code to a single 404 for
   * "doesn't exist for you" regardless of the underlying reason. Without
   * this, an attacker could enumerate valid account UUIDs by observing
   * `403` (exists, just not yours) vs `404` (doesn't exist at all).
   * Industry standard (GitHub, GitLab, Stripe all do this).
   *
   * Admin still gets through unconditionally because their job depends
   * on cross-tenant visibility.
   */
  assertOwnerOrAdmin(account: AccountRow, actor: AuthUser): void {
    if (actor.role === "admin") return;
    if (account.ownerId !== actor.id) {
      throw new NotFoundError(`Account '${account.id}' not found.`);
    }
  }
}
