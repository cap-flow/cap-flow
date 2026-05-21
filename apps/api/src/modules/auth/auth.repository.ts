import { type Database, schema } from "@cap-flow/db";
import { and, eq, isNotNull, isNull } from "drizzle-orm";

export type UserRow = typeof schema.users.$inferSelect;
export type SessionRow = typeof schema.sessions.$inferSelect;

export interface CreateSessionInput {
  readonly userId: string;
  readonly sessionTokenHash: string;
  readonly userAgent: string | null;
  readonly ip: string | null;
  readonly expiresAt: Date;
  /** Set on impersonation sessions: the admin who initiated. Persists
   *  across refresh rotations so the banner survives page reloads. */
  readonly impersonatedById?: string;
  readonly impersonationMode?: "view" | "edit";
  /**
   * H1: rotation chain. NULL on login → server stamps with the new
   * session.id (self-rooted family). On rotation, copy from the
   * parent session so the chain stays linkable for reuse-detection.
   */
  readonly familyId?: string;
}

export interface CreateUserInput {
  readonly email: string;
  readonly name: string;
  readonly passwordHash: string;
  readonly role: "admin" | "user" | "viewer";
}

export interface IAuthRepository {
  findActiveUserByEmail(email: string): Promise<UserRow | null>;
  findUserByEmail(email: string): Promise<UserRow | null>;
  /**
   * Lookup активного юзера по identifier'у который может быть email
   * ИЛИ username. Содержит "@" → email; иначе username. Возвращает
   * только enrolled (password_hash NOT NULL) и status=active —
   * Telegram-signup юзеры ДО set-password (status=pending) не могут
   * залогиниться по паролю даже если уже задали username.
   */
  findActiveUserByEmailOrUsername(
    identifier: string,
  ): Promise<UserRow | null>;
  findActiveUserById(id: string): Promise<UserRow | null>;
  /** Any user by id, including blocked/pending — used by email verification. */
  findUserById(id: string): Promise<UserRow | null>;
  createUser(input: CreateUserInput): Promise<UserRow>;
  setPasswordHash(userId: string, passwordHash: string): Promise<void>;
  touchUserLastLogin(userId: string, when: Date): Promise<void>;
  /** B4: stamp `users.email_verified_at` only if currently NULL (don't overwrite earlier verifications). */
  markEmailVerified(userId: string, at: Date): Promise<UserRow | null>;
  createSession(input: CreateSessionInput): Promise<SessionRow>;
  findActiveSessionByTokenHash(tokenHash: string): Promise<SessionRow | null>;
  /**
   * H1: lookup by token hash regardless of revoked_at — used by refresh
   * flow to detect reuse of an already-rotated token. Returns null only
   * when the hash truly doesn't exist.
   */
  findAnySessionByTokenHash(tokenHash: string): Promise<SessionRow | null>;
  findActiveSessionById(id: string): Promise<SessionRow | null>;
  revokeSession(sessionId: string, when: Date, reason?: string): Promise<void>;
  /** H1: revoke every session in a family (token-reuse detector hammer). */
  revokeSessionFamily(
    familyId: string,
    when: Date,
    reason: string
  ): Promise<number>;
  touchSessionLastUsed(sessionId: string, when: Date): Promise<void>;
}

export class AuthRepository implements IAuthRepository {
  constructor(private readonly db: Database) {}

  /** Active user with email + password set. NULL if not enrolled in email/password auth. */
  async findActiveUserByEmail(email: string): Promise<UserRow | null> {
    const rows = await this.db
      .select()
      .from(schema.users)
      .where(
        and(
          eq(schema.users.email, email.toLowerCase()),
          eq(schema.users.status, "active"),
          isNotNull(schema.users.passwordHash)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async findUserByEmail(email: string): Promise<UserRow | null> {
    const rows = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email.toLowerCase()))
      .limit(1);
    return rows[0] ?? null;
  }

  async findActiveUserByEmailOrUsername(
    identifier: string,
  ): Promise<UserRow | null> {
    const trimmed = identifier.trim();
    if (!trimmed) return null;
    // Эвристика: содержит "@" → ищем по email; иначе по username.
    // Не пытаемся "ИЛИ" одним запросом — обе колонки UNIQUE, поэтому
    // двух round-trip'ов достаточно и проще для индексного планировщика.
    if (trimmed.includes("@")) {
      return this.findActiveUserByEmail(trimmed);
    }
    const rows = await this.db
      .select()
      .from(schema.users)
      .where(
        and(
          eq(schema.users.username, trimmed),
          eq(schema.users.status, "active"),
          isNotNull(schema.users.passwordHash),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async findActiveUserById(id: string): Promise<UserRow | null> {
    const rows = await this.db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.id, id), eq(schema.users.status, "active")))
      .limit(1);
    return rows[0] ?? null;
  }

  async createUser(input: CreateUserInput): Promise<UserRow> {
    const [row] = await this.db
      .insert(schema.users)
      .values({
        email: input.email.toLowerCase(),
        name: input.name,
        passwordHash: input.passwordHash,
        role: input.role,
        status: "active",
      })
      .returning();
    if (!row) throw new Error("User insert returned no row.");
    return row;
  }

  async setPasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.db
      .update(schema.users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(schema.users.id, userId));
  }

  async findUserById(id: string): Promise<UserRow | null> {
    const rows = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Stamp `email_verified_at = at` only if it's currently NULL. Returns the
   * fresh row (or the existing one if already verified earlier). This is
   * the email-verification idempotency contract: confirming a token twice,
   * or after admin manually verified, must not overwrite the older timestamp.
   */
  async markEmailVerified(userId: string, at: Date): Promise<UserRow | null> {
    const [row] = await this.db
      .update(schema.users)
      .set({ emailVerifiedAt: at, updatedAt: at })
      .where(and(eq(schema.users.id, userId), isNull(schema.users.emailVerifiedAt)))
      .returning();
    if (row) return row;
    // Either user doesn't exist, or already verified earlier.
    const rows = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    return rows[0] ?? null;
  }

  async touchUserLastLogin(userId: string, when: Date): Promise<void> {
    await this.db
      .update(schema.users)
      .set({ lastLoginAt: when, updatedAt: when })
      .where(eq(schema.users.id, userId));
  }

  async createSession(input: CreateSessionInput): Promise<SessionRow> {
    const [row] = await this.db
      .insert(schema.sessions)
      .values({
        userId: input.userId,
        sessionTokenHash: input.sessionTokenHash,
        userAgent: input.userAgent,
        ip: input.ip,
        expiresAt: input.expiresAt,
        ...(input.familyId ? { familyId: input.familyId } : {}),
        ...(input.impersonatedById
          ? {
              impersonatedById: input.impersonatedById,
              impersonationMode: input.impersonationMode ?? "view",
            }
          : {}),
      })
      .returning();
    if (!row) throw new Error("Session insert returned no row.");
    // H1: self-root the family on login (no parent supplied).
    if (!input.familyId) {
      await this.db
        .update(schema.sessions)
        .set({ familyId: row.id })
        .where(eq(schema.sessions.id, row.id));
      return { ...row, familyId: row.id };
    }
    return row;
  }

  async findActiveSessionByTokenHash(
    tokenHash: string
  ): Promise<SessionRow | null> {
    const rows = await this.db
      .select()
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.sessionTokenHash, tokenHash),
          isNull(schema.sessions.revokedAt)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async findAnySessionByTokenHash(
    tokenHash: string
  ): Promise<SessionRow | null> {
    const rows = await this.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.sessionTokenHash, tokenHash))
      .limit(1);
    return rows[0] ?? null;
  }

  async findActiveSessionById(id: string): Promise<SessionRow | null> {
    const rows = await this.db
      .select()
      .from(schema.sessions)
      .where(
        and(eq(schema.sessions.id, id), isNull(schema.sessions.revokedAt))
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async revokeSession(
    sessionId: string,
    when: Date,
    reason: string = "rotated"
  ): Promise<void> {
    await this.db
      .update(schema.sessions)
      .set({ revokedAt: when, revokedReason: reason })
      .where(eq(schema.sessions.id, sessionId));
  }

  async revokeSessionFamily(
    familyId: string,
    when: Date,
    reason: string
  ): Promise<number> {
    const rows = await this.db
      .update(schema.sessions)
      .set({ revokedAt: when, revokedReason: reason })
      .where(
        and(
          eq(schema.sessions.familyId, familyId),
          isNull(schema.sessions.revokedAt)
        )
      )
      .returning({ id: schema.sessions.id });
    return rows.length;
  }

  async touchSessionLastUsed(sessionId: string, when: Date): Promise<void> {
    await this.db
      .update(schema.sessions)
      .set({ lastUsedAt: when })
      .where(eq(schema.sessions.id, sessionId));
  }
}
