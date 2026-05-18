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
      .values({ ...input, purpose: "password_reset" })
      .returning();
    if (!row) throw new Error("auth_tokens insert returned no row.");
    return row;
  }

  async findActiveByHash(tokenHash: string): Promise<AuthTokenRow | null> {
    // B4: scope by purpose so an email-verification token cannot be
    // consumed via the password-reset flow.
    const rows = await this.db
      .select()
      .from(schema.authTokens)
      .where(
        and(
          eq(schema.authTokens.tokenHash, tokenHash),
          eq(schema.authTokens.purpose, "password_reset"),
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
