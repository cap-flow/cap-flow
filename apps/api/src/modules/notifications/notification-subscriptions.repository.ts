import { type Database, schema } from "@cap-flow/db";
import { and, eq } from "drizzle-orm";

export type NotificationSubscriptionRow =
  typeof schema.notificationSubscriptions.$inferSelect;

export type NotificationChannel = "email" | "telegram";

export interface UpsertSubscriptionInput {
  readonly userId: string;
  readonly type: string;
  readonly channel: NotificationChannel;
  readonly enabled: boolean;
}

export class NotificationSubscriptionsRepository {
  constructor(private readonly db: Database) {}

  async listForUser(userId: string): Promise<NotificationSubscriptionRow[]> {
    return this.db
      .select()
      .from(schema.notificationSubscriptions)
      .where(eq(schema.notificationSubscriptions.userId, userId));
  }

  /**
   * Is this user opted in to (`type`, `channel`)? Defaults to true if no
   * row — we want users to *receive* important notifications by default
   * (password reset, invite). Opt-out by upserting `enabled = false`.
   */
  async isEnabled(
    userId: string,
    type: string,
    channel: NotificationChannel
  ): Promise<boolean> {
    const rows = await this.db
      .select({ enabled: schema.notificationSubscriptions.enabled })
      .from(schema.notificationSubscriptions)
      .where(
        and(
          eq(schema.notificationSubscriptions.userId, userId),
          eq(schema.notificationSubscriptions.type, type),
          eq(schema.notificationSubscriptions.channel, channel)
        )
      )
      .limit(1);
    return rows[0]?.enabled ?? true;
  }

  async upsert(
    input: UpsertSubscriptionInput
  ): Promise<NotificationSubscriptionRow> {
    const existing = await this.db
      .select()
      .from(schema.notificationSubscriptions)
      .where(
        and(
          eq(schema.notificationSubscriptions.userId, input.userId),
          eq(schema.notificationSubscriptions.type, input.type),
          eq(schema.notificationSubscriptions.channel, input.channel)
        )
      )
      .limit(1);

    if (existing[0]) {
      const [row] = await this.db
        .update(schema.notificationSubscriptions)
        .set({ enabled: input.enabled, updatedAt: new Date() })
        .where(
          and(
            eq(schema.notificationSubscriptions.userId, input.userId),
            eq(schema.notificationSubscriptions.type, input.type),
            eq(schema.notificationSubscriptions.channel, input.channel)
          )
        )
        .returning();
      if (!row) throw new Error("Subscription update returned no row.");
      return row;
    }

    const [row] = await this.db
      .insert(schema.notificationSubscriptions)
      .values({
        userId: input.userId,
        type: input.type,
        channel: input.channel,
        enabled: input.enabled,
      })
      .returning();
    if (!row) throw new Error("Subscription insert returned no row.");
    return row;
  }
}
