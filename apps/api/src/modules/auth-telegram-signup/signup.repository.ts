/**
 * DB operations для Telegram-signup потока.
 *
 * Отделён от `AuthRepository` чтобы:
 *   - не раздувать auth.repository.ts ещё одной парой методов,
 *   - типовые тесты на signup-flow моки не задевали core auth.
 *
 * См. `signup.service.ts` для high-level flow.
 */
import { createHash, randomBytes } from "node:crypto";

import { type Database, schema } from "@cap-flow/db";
import { and, eq, isNull, sql } from "drizzle-orm";

import type { UserRow } from "../auth/auth.repository.js";

export interface CreateNonceInput {
  readonly nonceHash: string;
  readonly expiresAt: Date;
}

export interface BindNonceInput {
  readonly nonceHash: string;
  readonly userId: string;
  readonly telegramUserId: number;
  readonly telegramChatId: number;
  readonly telegramUsername: string | null;
}

export interface CreateTelegramUserInput {
  readonly telegramUserId: number;
  readonly telegramUsername: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  /** Chat ID для авто-связи telegram_links записи (= notifications target). */
  readonly telegramChatId: number;
}

export type TelegramSignupNonceRow =
  typeof schema.telegramSignupNonces.$inferSelect;

export interface ITelegramSignupRepository {
  createNonce(input: CreateNonceInput): Promise<void>;
  /** По raw `nonceHash`. Возвращает строку как есть (consumed / expired не фильтруются — caller проверяет). */
  findNonce(nonceHash: string): Promise<TelegramSignupNonceRow | null>;
  /** Атомарно записывает user binding + Telegram identity на nonce-строку. */
  bindNonceToUser(input: BindNonceInput): Promise<void>;
  /**
   * One-shot consume: атомарно проставляет consumed_at и возвращает
   * предыдущее состояние строки (если consume прошёл). Если строка
   * уже consumed / expired / без user_id → null.
   */
  consumeNonce(nonceHash: string): Promise<TelegramSignupNonceRow | null>;
  findUserByTelegramId(telegramUserId: number): Promise<UserRow | null>;
  /** Lookup user by id IGNORING `status` фильтра — signup-user'у со status="pending" нужно успешно finish'нуться. */
  findUserAnyStatusById(userId: string): Promise<UserRow | null>;
  /** Создаёт shell-пользователя со status="pending" и password_hash NULL. */
  createTelegramUser(input: CreateTelegramUserInput): Promise<UserRow>;
  /**
   * Idempotent backfill: гарантирует что у юзера есть primary account
   * и linked telegram_links row. Используется и для свежих signup, и
   * для returning users (если предыдущий signup-вариант не доделал
   * провижн). NO-OP если строки уже есть.
   */
  ensureUserDefaults(input: {
    userId: string;
    telegramChatId: number;
    telegramUsername: string | null;
  }): Promise<void>;
  /**
   * Записывает password_hash + (опционально) username, переводит
   * status в "active". UNIQUE-conflict на username → throws.
   */
  setInitialPasswordAndUsername(
    userId: string,
    passwordHash: string,
    username: string | null,
  ): Promise<void>;
}

export class TelegramSignupRepository implements ITelegramSignupRepository {
  constructor(private readonly db: Database) {}

  async createNonce(input: CreateNonceInput): Promise<void> {
    await this.db.insert(schema.telegramSignupNonces).values({
      nonceHash: input.nonceHash,
      expiresAt: input.expiresAt,
    });
  }

  async findNonce(
    nonceHash: string,
  ): Promise<TelegramSignupNonceRow | null> {
    const rows = await this.db
      .select()
      .from(schema.telegramSignupNonces)
      .where(eq(schema.telegramSignupNonces.nonceHash, nonceHash))
      .limit(1);
    return rows[0] ?? null;
  }

  async bindNonceToUser(input: BindNonceInput): Promise<void> {
    await this.db
      .update(schema.telegramSignupNonces)
      .set({
        userId: input.userId,
        telegramUserId: input.telegramUserId,
        telegramChatId: input.telegramChatId,
        telegramUsername: input.telegramUsername,
      })
      .where(eq(schema.telegramSignupNonces.nonceHash, input.nonceHash));
  }

  async consumeNonce(
    nonceHash: string,
  ): Promise<TelegramSignupNonceRow | null> {
    // Атомарный consume: одним UPDATE'ом помечаем consumed_at, фильтр
    // не пускает уже-consumed / expired / unbound строки. .returning()
    // отдаёт значения ПОСЛЕ обновления, но нам этого достаточно —
    // user_id, telegram_user_id и пр. не меняются.
    const rows = await this.db
      .update(schema.telegramSignupNonces)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(schema.telegramSignupNonces.nonceHash, nonceHash),
          isNull(schema.telegramSignupNonces.consumedAt),
          sql`${schema.telegramSignupNonces.expiresAt} > now()`,
          sql`${schema.telegramSignupNonces.userId} IS NOT NULL`,
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  async findUserByTelegramId(
    telegramUserId: number,
  ): Promise<UserRow | null> {
    const rows = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.telegramId, telegramUserId))
      .limit(1);
    return rows[0] ?? null;
  }

  async findUserAnyStatusById(userId: string): Promise<UserRow | null> {
    const rows = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    return rows[0] ?? null;
  }

  async createTelegramUser(
    input: CreateTelegramUserInput,
  ): Promise<UserRow> {
    return await this.db.transaction(async (tx) => {
      const [user] = await tx
        .insert(schema.users)
        .values({
          telegramId: input.telegramUserId,
          telegramUsername: input.telegramUsername,
          firstName: input.firstName,
          lastName: input.lastName,
          // password_hash NULL → set-password page потребуется
          // status=pending → set-password переключит на active.
          status: "pending",
          role: "user",
        })
        .returning();
      if (!user) throw new Error("User insert returned no row.");
      await this.insertDefaultsTx(tx, {
        userId: user.id,
        telegramChatId: input.telegramChatId,
        telegramUsername: input.telegramUsername,
      });
      return user;
    });
  }

  async ensureUserDefaults(input: {
    userId: string;
    telegramChatId: number;
    telegramUsername: string | null;
  }): Promise<void> {
    // Idempotent: проверяем существование строк перед INSERT'ом.
    // Используется для returning users (вернулись через bot после
    // того, как предыдущий signup-flow вышел из строя и не успел
    // провижнуть account/link).
    return await this.db.transaction(async (tx) => {
      await this.insertDefaultsTx(tx, input);
    });
  }

  private async insertDefaultsTx(
    tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
    input: {
      userId: string;
      telegramChatId: number;
      telegramUsername: string | null;
    },
  ): Promise<void> {
    // Primary account — пропускаем если уже есть.
    const existingAccounts = await tx
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.ownerId, input.userId),
          isNull(schema.accounts.archivedAt),
        ),
      )
      .limit(1);
    if (existingAccounts.length === 0) {
      await tx.insert(schema.accounts).values({
        ownerId: input.userId,
        name: "Main",
        isPrimary: true,
      });
    }

    // telegram_links — пропускаем если уже linked (любой row, не
    // только revoked-aware: для signup-flow важен сам факт «бот знает
    // этот chat»).
    const existingLink = await tx
      .select({ id: schema.telegramLinks.id })
      .from(schema.telegramLinks)
      .where(
        and(
          eq(schema.telegramLinks.userId, input.userId),
          eq(schema.telegramLinks.status, "linked"),
          isNull(schema.telegramLinks.revokedAt),
        ),
      )
      .limit(1);
    if (existingLink.length === 0) {
      const syntheticHash =
        "signup:" + createHash("sha256").update(randomBytes(16)).digest("hex");
      const now = new Date();
      await tx.insert(schema.telegramLinks).values({
        userId: input.userId,
        startCodeHash: syntheticHash,
        status: "linked",
        chatId: input.telegramChatId,
        telegramUsername: input.telegramUsername,
        linkedAt: now,
        // expires_at NOT NULL — для уже-linked nominal.
        expiresAt: now,
      });
    }
  }

  async setInitialPasswordAndUsername(
    userId: string,
    passwordHash: string,
    username: string | null,
  ): Promise<void> {
    await this.db
      .update(schema.users)
      .set({
        passwordHash,
        username,
        status: "active",
        updatedAt: new Date(),
      })
      .where(eq(schema.users.id, userId));
  }
}
