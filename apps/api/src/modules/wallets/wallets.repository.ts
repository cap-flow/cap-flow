import { type Database, schema } from "@cap-flow/db";
import { asc, eq } from "drizzle-orm";

export type WalletRow = typeof schema.wallets.$inferSelect;
export type WalletAddressRow = typeof schema.walletAddresses.$inferSelect;

export interface CreateWalletInput {
  readonly accountId: string;
  readonly name: string;
  readonly kind: "internal" | "external";
}

export interface CreateAddressInput {
  readonly walletId: string;
  readonly address: string;
  readonly type: "evm" | "solana" | "tron" | "btc" | "other";
  readonly chains: number[];
}

export class WalletsRepository {
  constructor(private readonly db: Database) {}

  // ─── wallets ──────────────────────────────────────────────────────

  async listByAccount(accountId: string): Promise<WalletRow[]> {
    return this.db
      .select()
      .from(schema.wallets)
      .where(eq(schema.wallets.accountId, accountId))
      .orderBy(asc(schema.wallets.createdAt));
  }

  async findById(id: string): Promise<WalletRow | null> {
    const rows = await this.db
      .select()
      .from(schema.wallets)
      .where(eq(schema.wallets.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async create(input: CreateWalletInput): Promise<WalletRow> {
    const [row] = await this.db
      .insert(schema.wallets)
      .values({
        accountId: input.accountId,
        name: input.name,
        kind: input.kind,
      })
      .returning();
    if (!row) throw new Error("wallet insert returned no row");
    return row;
  }

  async rename(id: string, name: string): Promise<WalletRow | null> {
    const [row] = await this.db
      .update(schema.wallets)
      .set({ name, updatedAt: new Date() })
      .where(eq(schema.wallets.id, id))
      .returning();
    return row ?? null;
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(schema.wallets)
      .where(eq(schema.wallets.id, id))
      .returning({ id: schema.wallets.id });
    return rows.length > 0;
  }

  // ─── addresses ────────────────────────────────────────────────────

  async listAddresses(walletId: string): Promise<WalletAddressRow[]> {
    return this.db
      .select()
      .from(schema.walletAddresses)
      .where(eq(schema.walletAddresses.walletId, walletId))
      .orderBy(asc(schema.walletAddresses.createdAt));
  }

  async listAddressesByAccount(
    accountId: string
  ): Promise<Array<WalletAddressRow & { walletName: string }>> {
    const rows = await this.db
      .select({
        addr: schema.walletAddresses,
        walletName: schema.wallets.name,
      })
      .from(schema.walletAddresses)
      .innerJoin(
        schema.wallets,
        eq(schema.wallets.id, schema.walletAddresses.walletId)
      )
      .where(eq(schema.wallets.accountId, accountId));
    return rows.map((r) => ({ ...r.addr, walletName: r.walletName }));
  }

  async findAddressById(id: string): Promise<WalletAddressRow | null> {
    const rows = await this.db
      .select()
      .from(schema.walletAddresses)
      .where(eq(schema.walletAddresses.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async addAddress(input: CreateAddressInput): Promise<WalletAddressRow> {
    const [row] = await this.db
      .insert(schema.walletAddresses)
      .values({
        walletId: input.walletId,
        address: input.address,
        type: input.type,
        chains: input.chains,
      })
      .returning();
    if (!row) throw new Error("address insert returned no row");
    return row;
  }

  async deleteAddress(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(schema.walletAddresses)
      .where(eq(schema.walletAddresses.id, id))
      .returning({ id: schema.walletAddresses.id });
    return rows.length > 0;
  }

  /**
   * Resolve an address row + its wallet's account_id in one query. Used
   * by the tenant-isolation guard in routes — we never trust a raw
   * `addressId` from the URL alone.
   */
  async findAddressWithAccount(
    id: string
  ): Promise<{ row: WalletAddressRow; accountId: string } | null> {
    const rows = await this.db
      .select({
        row: schema.walletAddresses,
        accountId: schema.wallets.accountId,
      })
      .from(schema.walletAddresses)
      .innerJoin(
        schema.wallets,
        eq(schema.wallets.id, schema.walletAddresses.walletId)
      )
      .where(eq(schema.walletAddresses.id, id))
      .limit(1);
    return rows[0] ?? null;
  }
}
