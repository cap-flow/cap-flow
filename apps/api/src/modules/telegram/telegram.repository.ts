import { type Database, schema } from "@cap-flow/db";
import { and, eq, isNull } from "drizzle-orm";

export type TelegramLinkRow = typeof schema.telegramLinks.$inferSelect;

export interface CreatePendingLinkInput {
  readonly userId: string;
  readonly startCodeHash: string;
  readonly expiresAt: Date;
}

export class TelegramRepository {
  constructor(private readonly db: Database) {}

  async findActiveByUser(userId: string): Promise<TelegramLinkRow | null> {
    const rows = await this.db
      .select()
      .from(schema.telegramLinks)
      .where(
        and(
          eq(schema.telegramLinks.userId, userId),
          eq(schema.telegramLinks.status, "linked"),
          isNull(schema.telegramLinks.revokedAt)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async findPendingByUser(userId: string): Promise<TelegramLinkRow | null> {
    const rows = await this.db
      .select()
      .from(schema.telegramLinks)
      .where(
        and(
          eq(schema.telegramLinks.userId, userId),
          eq(schema.telegramLinks.status, "pending")
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Used by the bot listener side (Phase 7b). */
  async findByStartCode(hash: string): Promise<TelegramLinkRow | null> {
    const rows = await this.db
      .select()
      .from(schema.telegramLinks)
      .where(eq(schema.telegramLinks.startCodeHash, hash))
      .limit(1);
    return rows[0] ?? null;
  }

  async createPending(input: CreatePendingLinkInput): Promise<TelegramLinkRow> {
    const [row] = await this.db
      .insert(schema.telegramLinks)
      .values({
        userId: input.userId,
        startCodeHash: input.startCodeHash,
        expiresAt: input.expiresAt,
        status: "pending",
      })
      .returning();
    if (!row) throw new Error("telegram_links insert returned no row.");
    return row;
  }

  async markLinked(
    id: string,
    chatId: number,
    telegramUsername: string | null
  ): Promise<void> {
    await this.db
      .update(schema.telegramLinks)
      .set({
        status: "linked",
        chatId,
        telegramUsername,
        linkedAt: new Date(),
      })
      .where(eq(schema.telegramLinks.id, id));
  }

  async revoke(userId: string): Promise<number> {
    const rows = await this.db
      .update(schema.telegramLinks)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(
        and(
          eq(schema.telegramLinks.userId, userId),
          isNull(schema.telegramLinks.revokedAt)
        )
      )
      .returning({ id: schema.telegramLinks.id });
    return rows.length;
  }
}
