import { type Database, schema } from "@cap-flow/db";
import { and, count, desc, eq, ilike, inArray, isNull, sql } from "drizzle-orm";

import { NotFoundError } from "../../core/errors.js";
import type { AuditService } from "../audit/audit.service.js";
import type { IAuthRepository, UserRow } from "../auth/auth.repository.js";
import {
  generateRefreshToken,
  hashToken,
  signAccessToken,
} from "../auth/tokens.js";

export interface AdminUsersConfig {
  readonly jwtSecret: string;
  readonly accessTtlMinutes: number;
  readonly refreshTtlDays: number;
  readonly impersonationTtlMinutes: number;
}

export interface ImpersonateResult {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
  readonly impersonatedUser: UserRow;
}

export interface UserListFilter {
  readonly status?: "active" | "pending" | "blocked";
  readonly role?: "admin" | "user" | "viewer";
  readonly search?: string;
}

export interface UserListEntry {
  readonly user: UserRow;
  readonly accountCount: number;
  readonly lastSnapshotAt: Date | null;
  readonly lastSnapshotUsd: number | null;
}

/**
 * Admin user management + impersonation.
 *
 * Phase 2 introduced impersonation; Phase 5 adds:
 *   - listUsers with filters + per-user aggregates (account count, latest
 *     snapshot date / totalUsd) — what the admin user-list table renders.
 *   - updateUser for status (suspend / unsuspend / delete) and role.
 */
export class AdminUsersService {
  constructor(
    private readonly db: Database,
    private readonly authRepo: IAuthRepository,
    private readonly audit: AuditService,
    private readonly config: AdminUsersConfig
  ) {}

  // ─── list / detail ───────────────────────────────────────────────────

  /**
   * One SQL query that returns each user + their account count + the
   * latest snapshot timestamp + totalUsd. Latest-snapshot is a correlated
   * subquery — for 100s of users it's fine; if we ever need to scale up,
   * promote to a materialised view refreshed by the worker.
   */
  async listUsers(filter: UserListFilter = {}): Promise<UserListEntry[]> {
    const whereClauses = [];
    if (filter.status) {
      whereClauses.push(eq(schema.users.status, filter.status));
    }
    if (filter.role) {
      whereClauses.push(eq(schema.users.role, filter.role));
    }
    if (filter.search && filter.search.trim().length > 0) {
      const pattern = `%${filter.search.trim()}%`;
      whereClauses.push(
        sql`(${ilike(schema.users.email, pattern)} OR ${ilike(
          schema.users.name,
          pattern
        )})`
      );
    }
    const whereExpr =
      whereClauses.length > 0 ? and(...whereClauses) : undefined;

    // Note: `${schema.users.id}` would emit just `"id"` (no table qualifier),
    // which is ambiguous inside the correlated subqueries that join
    // `accounts a` / `portfolio_snapshots ps`. Reference the outer row
    // explicitly as `users.id` via raw SQL.
    const baseQuery = this.db
      .select({
        user: schema.users,
        accountCount: sql<number>`
          (SELECT COUNT(*)::int FROM ${schema.accounts}
           WHERE ${schema.accounts.ownerId} = users.id
             AND ${schema.accounts.archivedAt} IS NULL)
        `,
        lastSnapshotAt: sql<Date | null>`
          (SELECT MAX(ps.created_at) FROM ${schema.portfolioSnapshots} ps
           JOIN ${schema.accounts} a ON a.id = ps.account_id
           WHERE a.owner_id = users.id)
        `,
        lastSnapshotUsd: sql<number | null>`
          (SELECT (ps.metrics->>'totalUsd')::numeric
           FROM ${schema.portfolioSnapshots} ps
           JOIN ${schema.accounts} a ON a.id = ps.account_id
           WHERE a.owner_id = users.id
           ORDER BY ps.created_at DESC LIMIT 1)
        `,
      })
      .from(schema.users);

    const rows = whereExpr
      ? await baseQuery.where(whereExpr).orderBy(desc(schema.users.createdAt))
      : await baseQuery.orderBy(desc(schema.users.createdAt));

    return rows.map((r) => ({
      user: r.user,
      accountCount: Number(r.accountCount ?? 0),
      // PG returns the raw subquery timestamp as an ISO string; normalize
      // to Date here so the route can call .toISOString() uniformly.
      lastSnapshotAt: r.lastSnapshotAt
        ? r.lastSnapshotAt instanceof Date
          ? r.lastSnapshotAt
          : new Date(r.lastSnapshotAt)
        : null,
      lastSnapshotUsd:
        r.lastSnapshotUsd !== null && r.lastSnapshotUsd !== undefined
          ? Number(r.lastSnapshotUsd)
          : null,
    }));
  }

  async findUserById(id: string): Promise<UserRow | null> {
    const rows = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  // ─── mutations (admin actions on a user) ─────────────────────────────

  async setStatus(
    userId: string,
    next: "active" | "pending" | "blocked",
    actorAdminId: string
  ): Promise<UserRow> {
    const user = await this.findUserById(userId);
    if (!user) throw new NotFoundError(`User '${userId}' not found.`);

    const [updated] = await this.db
      .update(schema.users)
      .set({ status: next, updatedAt: new Date() })
      .where(eq(schema.users.id, userId))
      .returning();
    if (!updated) throw new NotFoundError(`User '${userId}' not found.`);

    // If blocked or set to pending, revoke all active sessions immediately.
    if (next !== "active") {
      await this.db
        .update(schema.sessions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(schema.sessions.userId, userId),
            isNull(schema.sessions.revokedAt)
          )
        );
    }

    await this.audit.log({
      actorUserId: actorAdminId,
      asAdmin: true,
      targetUserId: userId,
      action: "admin.user_status_changed",
      payload: { from: user.status, to: next },
    });

    return updated;
  }

  async setRole(
    userId: string,
    next: "admin" | "user" | "viewer",
    actorAdminId: string
  ): Promise<UserRow> {
    const user = await this.findUserById(userId);
    if (!user) throw new NotFoundError(`User '${userId}' not found.`);

    const [updated] = await this.db
      .update(schema.users)
      .set({ role: next, updatedAt: new Date() })
      .where(eq(schema.users.id, userId))
      .returning();
    if (!updated) throw new NotFoundError(`User '${userId}' not found.`);

    await this.audit.log({
      actorUserId: actorAdminId,
      asAdmin: true,
      targetUserId: userId,
      action: "admin.user_role_changed",
      payload: { from: user.role, to: next },
    });

    return updated;
  }

  // ─── impersonation (Phase 2 — kept here so all admin-user ops live in
  //                   one service) ─────────────────────────────────────

  async impersonate(args: {
    adminId: string;
    targetUserId: string;
    userAgent: string | null;
    ip: string | null;
  }): Promise<ImpersonateResult> {
    const target = await this.authRepo.findActiveUserById(args.targetUserId);
    if (!target) {
      throw new NotFoundError(`User '${args.targetUserId}' not found.`);
    }

    const now = new Date();
    const refreshToken = generateRefreshToken();
    const refreshTokenHash = hashToken(refreshToken);
    const expiresAt = new Date(
      now.getTime() + this.config.impersonationTtlMinutes * 60 * 1000
    );

    const [session] = await this.db
      .insert(schema.sessions)
      .values({
        userId: target.id,
        sessionTokenHash: refreshTokenHash,
        userAgent: args.userAgent,
        ip: args.ip,
        expiresAt,
        impersonatedById: args.adminId,
        impersonationMode: "view",
      })
      .returning();
    if (!session) throw new Error("Impersonation session insert failed.");

    const access = signAccessToken(
      {
        sub: target.id,
        role: target.role as "admin" | "user" | "viewer",
        sid: session.id,
      },
      this.config.jwtSecret,
      this.config.accessTtlMinutes
    );

    await this.audit.log({
      actorUserId: args.adminId,
      asAdmin: true,
      targetUserId: target.id,
      action: "admin.impersonation_started",
      payload: { sessionId: session.id, mode: "view" },
      ip: args.ip,
      userAgent: args.userAgent,
    });

    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken,
      refreshTokenExpiresAt: expiresAt,
      impersonatedUser: target,
    };
  }

  async endImpersonations(
    adminId: string,
    targetUserId: string
  ): Promise<number> {
    const now = new Date();
    const rows = await this.db
      .update(schema.sessions)
      .set({ revokedAt: now })
      .where(
        and(
          eq(schema.sessions.userId, targetUserId),
          eq(schema.sessions.impersonatedById, adminId),
          isNull(schema.sessions.revokedAt)
        )
      )
      .returning({ id: schema.sessions.id });
    if (rows.length > 0) {
      await this.audit.log({
        actorUserId: adminId,
        asAdmin: true,
        targetUserId,
        action: "admin.impersonation_ended",
        payload: { revokedSessions: rows.length },
      });
    }
    return rows.length;
  }

  // Used by audit-log viewer to resolve UUIDs → readable names.
  async resolveUserNames(
    ids: string[]
  ): Promise<Map<string, { email: string | null; name: string | null }>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
      })
      .from(schema.users)
      .where(inArray(schema.users.id, ids));
    return new Map(
      rows.map((r) => [r.id, { email: r.email, name: r.name }])
    );
  }

  /** total user counts for the SaaS metrics endpoint. */
  async statusCounts(): Promise<Record<string, number>> {
    const rows = await this.db
      .select({
        status: schema.users.status,
        n: count(schema.users.id),
      })
      .from(schema.users)
      .groupBy(schema.users.status);
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = Number(r.n);
    return out;
  }
}
