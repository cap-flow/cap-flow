import { ConflictError, NotFoundError } from "../../core/errors.js";
import type { AccountsService } from "../accounts/accounts.service.js";
import type { AuditService } from "../audit/audit.service.js";
import type { AuthUser } from "../auth/auth.types.js";

import type {
  WalletAddressRow,
  WalletRow,
  WalletsRepository,
} from "./wallets.repository.js";

export interface CreateWalletParams {
  readonly accountId: string;
  readonly name: string;
  readonly kind?: "internal" | "external";
}

export interface AddAddressParams {
  readonly walletId: string;
  readonly address: string;
  readonly type: "evm" | "solana" | "tron" | "btc" | "other";
  readonly chains: number[];
}

/**
 * Wallets management with tenant isolation.
 *
 * Every mutation goes through `accounts.getById(accountId, actor)` first —
 * that throws `Forbidden` for non-owners and `Not Found` for archived /
 * non-existent accounts, so the entire wallet surface inherits the
 * Phase 2 isolation contract for free.
 *
 * Audit entries:
 *   wallet.created / wallet.renamed / wallet.deleted
 *   wallet.address_added / wallet.address_deleted
 *
 * Identification of address `type` lives in the caller for now — could be
 * promoted to auto-detection (regex by prefix) in a later pass.
 */
export class WalletsService {
  constructor(
    private readonly repo: WalletsRepository,
    private readonly accounts: AccountsService,
    private readonly audit: AuditService
  ) {}

  // ─── wallets ──────────────────────────────────────────────────────

  async list(accountId: string, actor: AuthUser): Promise<WalletRow[]> {
    await this.accounts.getById(accountId, actor);
    return this.repo.listByAccount(accountId);
  }

  async create(
    p: CreateWalletParams,
    actor: AuthUser
  ): Promise<WalletRow> {
    await this.accounts.getById(p.accountId, actor);
    try {
      const row = await this.repo.create({
        accountId: p.accountId,
        name: p.name.trim(),
        kind: p.kind ?? "external",
      });
      await this.audit.log({
        actorUserId: actor.id,
        accountId: p.accountId,
        action: "wallet.created",
        payload: { walletId: row.id, name: row.name },
      });
      return row;
    } catch (err) {
      if (err instanceof Error && /duplicate key/i.test(err.message)) {
        throw new ConflictError(
          `Кошелёк с именем '${p.name}' уже есть в этом аккаунте.`
        );
      }
      throw err;
    }
  }

  async rename(
    walletId: string,
    name: string,
    actor: AuthUser
  ): Promise<WalletRow> {
    const wallet = await this.repo.findById(walletId);
    if (!wallet) throw new NotFoundError(`Wallet '${walletId}' not found.`);
    await this.accounts.getById(wallet.accountId, actor);
    const updated = await this.repo.rename(walletId, name.trim());
    if (!updated) throw new NotFoundError(`Wallet '${walletId}' not found.`);
    await this.audit.log({
      actorUserId: actor.id,
      accountId: wallet.accountId,
      action: "wallet.renamed",
      payload: { walletId, from: wallet.name, to: name },
    });
    return updated;
  }

  async delete(walletId: string, actor: AuthUser): Promise<void> {
    const wallet = await this.repo.findById(walletId);
    if (!wallet) throw new NotFoundError(`Wallet '${walletId}' not found.`);
    await this.accounts.getById(wallet.accountId, actor);
    const ok = await this.repo.delete(walletId);
    if (!ok) throw new NotFoundError(`Wallet '${walletId}' not found.`);
    await this.audit.log({
      actorUserId: actor.id,
      accountId: wallet.accountId,
      action: "wallet.deleted",
      payload: { walletId, name: wallet.name },
    });
  }

  // ─── addresses ────────────────────────────────────────────────────

  async listAddresses(
    walletId: string,
    actor: AuthUser
  ): Promise<WalletAddressRow[]> {
    const wallet = await this.repo.findById(walletId);
    if (!wallet) throw new NotFoundError(`Wallet '${walletId}' not found.`);
    await this.accounts.getById(wallet.accountId, actor);
    return this.repo.listAddresses(walletId);
  }

  async addAddress(
    p: AddAddressParams,
    actor: AuthUser
  ): Promise<WalletAddressRow> {
    const wallet = await this.repo.findById(p.walletId);
    if (!wallet) throw new NotFoundError(`Wallet '${p.walletId}' not found.`);
    await this.accounts.getById(wallet.accountId, actor);

    const normalized =
      p.type === "evm" ? p.address.toLowerCase() : p.address.trim();

    // 2026-05-25 (user request): prevent duplicates across ALL wallets
    // in account. Раньше можно было добавить тот же адрес в 2 разных
    // кошелька — портфолио суммировал балансы 2×. DB constraint
    // (walletId, address) спасал только от дубля в ОДНОМ кошельке.
    //
    // Поиск case-insensitive (lowercase EVM; trim для не-EVM). Если
    // найден → возвращаем 409 с пояснением какому кошельку он принадлежит.
    const existing = await this.repo.listAddressesByAccount(wallet.accountId);
    const dup = existing.find(
      (a) => a.address.toLowerCase() === normalized.toLowerCase(),
    );
    if (dup) {
      throw new ConflictError(
        `Адрес ${normalized.slice(0, 10)}… уже добавлен в кошелёк "${dup.walletName}". ` +
          `Удалите его оттуда или используйте другой адрес.`,
      );
    }

    try {
      const row = await this.repo.addAddress({
        walletId: p.walletId,
        address: normalized,
        type: p.type,
        chains: p.chains ?? [],
      });
      await this.audit.log({
        actorUserId: actor.id,
        accountId: wallet.accountId,
        action: "wallet.address_added",
        payload: {
          walletId: p.walletId,
          addressId: row.id,
          type: p.type,
          chains: p.chains,
        },
      });
      return row;
    } catch (err) {
      if (err instanceof Error && /duplicate key/i.test(err.message)) {
        throw new ConflictError(`Адрес уже добавлен в этот кошелёк.`);
      }
      throw err;
    }
  }

  async deleteAddress(
    addressId: string,
    actor: AuthUser
  ): Promise<void> {
    const found = await this.repo.findAddressWithAccount(addressId);
    if (!found) throw new NotFoundError(`Address '${addressId}' not found.`);
    await this.accounts.getById(found.accountId, actor);
    const ok = await this.repo.deleteAddress(addressId);
    if (!ok) throw new NotFoundError(`Address '${addressId}' not found.`);
    await this.audit.log({
      actorUserId: actor.id,
      accountId: found.accountId,
      action: "wallet.address_deleted",
      payload: { addressId },
    });
  }

  // ─── for refresh service ──────────────────────────────────────────

  /**
   * Called by `PortfolioRefreshService` to iterate addresses for a
   * scheduled snapshot. NOT auth-gated — service path is trusted (the
   * worker only knows accountIds from `accounts.findAllActive`).
   */
  async listAddressesForRefresh(
    accountId: string
  ): Promise<Array<WalletAddressRow & { walletName: string }>> {
    return this.repo.listAddressesByAccount(accountId);
  }

}
