import { type Database, schema } from "@cap-flow/db";
import { and, eq, isNull } from "drizzle-orm";

export type AuthTokenRow = typeof schema.authTokens.$inferSelect;

export interface CreateAuthTokenInput {
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

export interface IPasswordResetRepository {
  create(input: CreateAuthTokenInput): Promise<AuthTokenRow>;
  findActiveByHash(tokenHash: string): Promise<AuthTokenRow | null>;
  consume(id: string, when: Date): Promise<void>;
  revokeAllSessionsForUser(userId: string, when: Date): Promise<number>;
}

export class PasswordResetRepository implements IPasswordResetRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateAuthTokenInput): Promise<AuthTokenRow> {
    const [row] = await this.db
      .insert(schema.authTokens)
      .values(input)
      .returning();
    if (!row) throw new Error("auth_tokens insert returned no row.");
    return row;
  }

  async findActiveByHash(tokenHash: string): Promise<AuthTokenRow | null> {
    const rows = await this.db
      .select()
      .from(schema.authTokens)
      .where(
        and(
          eq(schema.authTokens.tokenHash, tokenHash),
          isNull(schema.authTokens.consumedAt)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async consume(id: string, when: Date): Promise<void> {
    await this.db
      .update(schema.authTokens)
      .set({ consumedAt: when })
      .where(eq(schema.authTokens.id, id));
  }

  async revokeAllSessionsForUser(
    userId: string,
    when: Date
  ): Promise<number> {
    const rows = await this.db
      .update(schema.sessions)
      .set({ revokedAt: when })
      .where(
        and(
          eq(schema.sessions.userId, userId),
          isNull(schema.sessions.revokedAt)
        )
      )
      .returning({ id: schema.sessions.id });
    return rows.length;
  }
}
