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
  findActiveUserById(id: string): Promise<UserRow | null>;
  createUser(input: CreateUserInput): Promise<UserRow>;
  setPasswordHash(userId: string, passwordHash: string): Promise<void>;
  touchUserLastLogin(userId: string, when: Date): Promise<void>;
  createSession(input: CreateSessionInput): Promise<SessionRow>;
  findActiveSessionByTokenHash(tokenHash: string): Promise<SessionRow | null>;
  findActiveSessionById(id: string): Promise<SessionRow | null>;
  revokeSession(sessionId: string, when: Date): Promise<void>;
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
        ...(input.impersonatedById
          ? {
              impersonatedById: input.impersonatedById,
              impersonationMode: input.impersonationMode ?? "view",
            }
          : {}),
      })
      .returning();
    if (!row) throw new Error("Session insert returned no row.");
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

  async revokeSession(sessionId: string, when: Date): Promise<void> {
    await this.db
      .update(schema.sessions)
      .set({ revokedAt: when })
      .where(eq(schema.sessions.id, sessionId));
  }

  async touchSessionLastUsed(sessionId: string, when: Date): Promise<void> {
    await this.db
      .update(schema.sessions)
      .set({ lastUsedAt: when })
      .where(eq(schema.sessions.id, sessionId));
  }
}
