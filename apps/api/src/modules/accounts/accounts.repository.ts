import { type Database, schema } from "@cap-flow/db";
import { and, asc, eq, isNull } from "drizzle-orm";

export type AccountRow = typeof schema.accounts.$inferSelect;

export interface CreateAccountInput {
  readonly ownerId: string;
  readonly name: string;
  readonly description?: string | null;
  readonly isPrimary?: boolean;
}

export interface UpdateAccountInput {
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
}

export interface IAccountsRepository {
  findById(id: string): Promise<AccountRow | null>;
  findActiveByOwner(ownerId: string): Promise<AccountRow[]>;
  findAllActive(): Promise<AccountRow[]>;
  countActiveByOwner(ownerId: string): Promise<number>;
  findPrimaryByOwner(ownerId: string): Promise<AccountRow | null>;
  getOwnerLastLoginAt(accountId: string): Promise<Date | null | undefined>;
  create(input: CreateAccountInput): Promise<AccountRow>;
  update(id: string, patch: UpdateAccountInput): Promise<AccountRow | null>;
  archive(id: string, when: Date): Promise<AccountRow | null>;
}

export class AccountsRepository implements IAccountsRepository {
  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<AccountRow | null> {
    const rows = await this.db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async findActiveByOwner(ownerId: string): Promise<AccountRow[]> {
    return this.db
      .select()
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.ownerId, ownerId),
          isNull(schema.accounts.archivedAt)
        )
      )
      .orderBy(asc(schema.accounts.createdAt));
  }

  async findAllActive(): Promise<AccountRow[]> {
    return this.db
      .select()
      .from(schema.accounts)
      .where(isNull(schema.accounts.archivedAt))
      .orderBy(asc(schema.accounts.createdAt));
  }

  async countActiveByOwner(ownerId: string): Promise<number> {
    const rows = await this.db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.ownerId, ownerId),
          isNull(schema.accounts.archivedAt)
        )
      );
    return rows.length;
  }

  async findPrimaryByOwner(ownerId: string): Promise<AccountRow | null> {
    const rows = await this.db
      .select()
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.ownerId, ownerId),
          eq(schema.accounts.isPrimary, true),
          isNull(schema.accounts.archivedAt)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Последний вход владельца аккаунта (для серверного cron-гейтинга
   * неактивных юзеров). Возвращает:
   *   - `Date`      — время последнего входа;
   *   - `null`      — владелец ни разу не логинился (`last_login_at IS NULL`);
   *   - `undefined` — аккаунт не найден.
   */
  async getOwnerLastLoginAt(
    accountId: string,
  ): Promise<Date | null | undefined> {
    const rows = await this.db
      .select({ lastLoginAt: schema.users.lastLoginAt })
      .from(schema.accounts)
      .innerJoin(schema.users, eq(schema.accounts.ownerId, schema.users.id))
      .where(eq(schema.accounts.id, accountId))
      .limit(1);
    if (rows.length === 0) return undefined;
    return rows[0]!.lastLoginAt;
  }

  async create(input: CreateAccountInput): Promise<AccountRow> {
    const [row] = await this.db
      .insert(schema.accounts)
      .values({
        ownerId: input.ownerId,
        name: input.name,
        description: input.description ?? null,
        isPrimary: input.isPrimary ?? false,
      })
      .returning();
    if (!row) throw new Error("Account insert returned no row.");
    return row;
  }

  /** Convenience for the registration / admin flows. */
  async createPrimary(input: {
    ownerId: string;
    name: string;
    description?: string | null;
  }): Promise<AccountRow> {
    return this.create({ ...input, isPrimary: true });
  }

  async update(
    id: string,
    patch: UpdateAccountInput
  ): Promise<AccountRow | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) set["name"] = patch.name;
    if (patch.description !== undefined) set["description"] = patch.description;

    const [row] = await this.db
      .update(schema.accounts)
      .set(set)
      .where(eq(schema.accounts.id, id))
      .returning();
    return row ?? null;
  }

  async archive(id: string, when: Date): Promise<AccountRow | null> {
    const [row] = await this.db
      .update(schema.accounts)
      .set({ archivedAt: when, updatedAt: when })
      .where(eq(schema.accounts.id, id))
      .returning();
    return row ?? null;
  }
}
