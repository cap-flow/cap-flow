import { type Database, schema } from "@cap-flow/db";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";

export type TelegramLinkRow = typeof schema.telegramLinks.$inferSelect;
export type TelegramMessageRow = typeof schema.telegramMessages.$inferSelect;

export interface SaveMessageInput {
  readonly userId: string;
  readonly chatId: number;
  readonly direction: "in" | "out";
  readonly text: string | null;
  readonly type?: "text" | "photo" | "document" | "audio" | "video" | "voice" | "sticker" | "other";
  readonly telegramMsgId?: number | null;
  readonly fileUrl?: string | null;
  readonly fileName?: string | null;
}

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

  /**
   * Admin chat: найти linked user по chat_id (для incoming webhook messages).
   * Возвращает null если chat_id не привязан ни к одному юзеру.
   */
  async findUserIdByChatId(chatId: number): Promise<string | null> {
    const rows = await this.db
      .select({ userId: schema.telegramLinks.userId })
      .from(schema.telegramLinks)
      .where(
        and(
          eq(schema.telegramLinks.chatId, chatId),
          eq(schema.telegramLinks.status, "linked"),
          isNull(schema.telegramLinks.revokedAt),
        ),
      )
      .limit(1);
    return rows[0]?.userId ?? null;
  }

  /* ─────────── Admin chat messages ─────────── */

  async saveMessage(input: SaveMessageInput): Promise<TelegramMessageRow> {
    const [row] = await this.db
      .insert(schema.telegramMessages)
      .values({
        userId: input.userId,
        chatId: input.chatId,
        direction: input.direction,
        type: input.type ?? "text",
        text: input.text,
        telegramMsgId: input.telegramMsgId ?? null,
        fileUrl: input.fileUrl ?? null,
        fileName: input.fileName ?? null,
      })
      .returning();
    if (!row) throw new Error("telegram_messages insert returned no row.");
    return row;
  }

  /**
   * List conversations: для каждого user_id берём last message + unread count.
   * Сортировка по last message time DESC.
   */
  async listConversations(): Promise<
    Array<{
      userId: string;
      lastText: string | null;
      lastDirection: "in" | "out";
      lastAt: Date;
      unreadCount: number;
    }>
  > {
    // Используем raw SQL для distinct on + window function (drizzle helpers
    // покрывают это менее красиво).
    const result = await this.db.execute<{
      userId: string;
      lastText: string | null;
      lastDirection: "in" | "out";
      lastAt: Date;
      unreadCount: number;
    }>(sql`
      WITH last_msg AS (
        SELECT DISTINCT ON (user_id)
          user_id, text, direction, created_at
        FROM telegram_messages
        ORDER BY user_id, created_at DESC
      ),
      unread AS (
        SELECT user_id, COUNT(*)::int AS unread_count
        FROM telegram_messages
        WHERE direction = 'in' AND read_at IS NULL
        GROUP BY user_id
      )
      SELECT
        lm.user_id::text       AS "userId",
        lm.text                AS "lastText",
        lm.direction::text     AS "lastDirection",
        lm.created_at          AS "lastAt",
        COALESCE(u.unread_count, 0) AS "unreadCount"
      FROM last_msg lm
      LEFT JOIN unread u USING (user_id)
      ORDER BY lm.created_at DESC
    `);
    return result.rows;
  }

  async listMessages(args: {
    userId: string;
    limit: number;
    before?: Date;
  }): Promise<TelegramMessageRow[]> {
    const conds = [eq(schema.telegramMessages.userId, args.userId)];
    if (args.before) {
      conds.push(lt(schema.telegramMessages.createdAt, args.before));
    }
    return this.db
      .select()
      .from(schema.telegramMessages)
      .where(and(...conds))
      .orderBy(desc(schema.telegramMessages.createdAt))
      .limit(args.limit);
  }

  /** Mark all incoming unread as read для conversation. */
  async markRead(userId: string): Promise<number> {
    const rows = await this.db
      .update(schema.telegramMessages)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(schema.telegramMessages.userId, userId),
          eq(schema.telegramMessages.direction, "in"),
          isNull(schema.telegramMessages.readAt),
        ),
      )
      .returning({ id: schema.telegramMessages.id });
    return rows.length;
  }

  /** Σ unread incoming across всех юзеров (для admin badge). */
  async totalUnread(): Promise<number> {
    const rows = await this.db
      .select({ c: sql<number>`COUNT(*)::int` })
      .from(schema.telegramMessages)
      .where(
        and(
          eq(schema.telegramMessages.direction, "in"),
          isNull(schema.telegramMessages.readAt),
        ),
      );
    return rows[0]?.c ?? 0;
  }
}
