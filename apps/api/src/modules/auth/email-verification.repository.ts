import { type Database, schema } from "@cap-flow/db";
import { and, eq, isNull } from "drizzle-orm";

import type {
  IEmailVerificationRepository,
  VerifyTokenRow,
} from "./email-verification.service.js";

/**
 * Email-verification token storage on top of the shared `auth_tokens`
 * table, scoped to `purpose='email_verification'` so it does not collide
 * with password-reset tokens.
 */
export class EmailVerificationRepository
  implements IEmailVerificationRepository
{
  constructor(private readonly db: Database) {}

  async insert(
    input: Omit<VerifyTokenRow, "id" | "createdAt" | "consumedAt">
  ): Promise<VerifyTokenRow> {
    const [row] = await this.db
      .insert(schema.authTokens)
      .values({
        tokenHash: input.tokenHash,
        userId: input.userId,
        emailAtIssue: input.emailAtIssue,
        expiresAt: input.expiresAt,
        purpose: "email_verification",
      })
      .returning();
    if (!row) throw new Error("auth_tokens insert returned no row.");
    return toVerifyRow(row);
  }

  async findByHash(tokenHash: string): Promise<VerifyTokenRow | null> {
    const rows = await this.db
      .select()
      .from(schema.authTokens)
      .where(
        and(
          eq(schema.authTokens.tokenHash, tokenHash),
          eq(schema.authTokens.purpose, "email_verification")
        )
      )
      .limit(1);
    return rows[0] ? toVerifyRow(rows[0]) : null;
  }

  async consume(id: string, at: Date): Promise<void> {
    await this.db
      .update(schema.authTokens)
      .set({ consumedAt: at })
      .where(eq(schema.authTokens.id, id));
  }

  async revokeAllForUser(userId: string, at: Date): Promise<number> {
    const rows = await this.db
      .update(schema.authTokens)
      .set({ consumedAt: at })
      .where(
        and(
          eq(schema.authTokens.userId, userId),
          eq(schema.authTokens.purpose, "email_verification"),
          isNull(schema.authTokens.consumedAt)
        )
      )
      .returning({ id: schema.authTokens.id });
    return rows.length;
  }
}

function toVerifyRow(
  r: typeof schema.authTokens.$inferSelect
): VerifyTokenRow {
  return {
    id: r.id,
    tokenHash: r.tokenHash,
    userId: r.userId,
    emailAtIssue: r.emailAtIssue ?? "",
    expiresAt: r.expiresAt,
    consumedAt: r.consumedAt,
    createdAt: r.createdAt,
  };
}
