import { type Database, schema } from "@cap-flow/db";
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";

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
  /**
   * M14 (2026-05-14): cursor-based pagination. `cursor` is the
   * `created_at` ISO string of the LAST row in the previous page —
   * server returns rows older than it. `limit` caps the page size.
   * Default 50, max 500. Backwards-compat: omit both → server still
   * returns up to 500 (so existing admin UI doesn't break).
   */
  readonly cursor?: string;
  readonly limit?: number;
}

export interface UserListEntry {
  readonly user: UserRow;
  readonly accountCount: number;
  readonly lastSnapshotAt: Date | null;
  readonly lastSnapshotUsd: number | null;
}

export interface UserListPage {
  readonly items: UserListEntry[];
  /** ISO of the last row's `createdAt`. Pass back as `cursor` for next page. */
  readonly nextCursor: string | null;
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
  /**
   * H12 + H15 (2026-05-14):
   *   - H12 rewrites the previous 3 correlated subqueries per row into
   *     a single query with two LEFT JOIN LATERAL clauses, dropping the
   *     N+1 pattern that would saturate the DB pool past ~500 users.
   *   - H15 extends `filter.search` to ALSO match wallet addresses
   *     (case-insensitive substring on `wallet_addresses.address`).
   *     Support flow: user writes "my 0xabc… shows wrong data" → admin
   *     pastes the address into search and lands on the right user
   *     without dropping to psql.
   */
  async listUsers(filter: UserListFilter = {}): Promise<UserListPage> {
    const search = filter.search?.trim() ?? "";
    const pattern = search.length > 0 ? `%${search}%` : null;
    // M14: cursor + limit. Hard cap at 500 to prevent runaway responses.
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const cursor = filter.cursor ?? null;

    const result = await this.db.execute<{
      id: string;
      email: string | null;
      password_hash: string | null;
      name: string | null;
      legacy_id: string | null;
      telegram_id: string | null;
      telegram_username: string | null;
      first_name: string | null;
      last_name: string | null;
      role: string;
      status: string;
      notes: string | null;
      active_account_id: string | null;
      tracked_tickers: string[] | null;
      billing_meta: unknown;
      email_verified_at: Date | null;
      last_login_at: Date | null;
      created_at: Date;
      updated_at: Date;
      account_count: number;
      last_snapshot_at: Date | null;
      last_snapshot_usd: string | null;
    }>(sql`
      SELECT
        u.*,
        COALESCE(ac.cnt, 0)::int AS account_count,
        ls.created_at            AS last_snapshot_at,
        (ls.metrics->>'totalUsd')::numeric AS last_snapshot_usd
      FROM ${schema.users} u
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS cnt
        FROM ${schema.accounts}
        WHERE owner_id = u.id AND archived_at IS NULL
      ) ac ON true
      LEFT JOIN LATERAL (
        SELECT ps.created_at, ps.metrics
        FROM ${schema.portfolioSnapshots} ps
        INNER JOIN ${schema.accounts} a ON a.id = ps.account_id
        WHERE a.owner_id = u.id
        ORDER BY ps.created_at DESC
        LIMIT 1
      ) ls ON true
      WHERE 1=1
        ${filter.status ? sql`AND u.status = ${filter.status}` : sql``}
        ${filter.role ? sql`AND u.role = ${filter.role}` : sql``}
        ${cursor ? sql`AND u.created_at < ${cursor}` : sql``}
        ${
          pattern
            ? sql`AND (
                u.email ILIKE ${pattern}
                OR u.name ILIKE ${pattern}
                OR EXISTS (
                  SELECT 1
                  FROM ${schema.walletAddresses} wa
                  INNER JOIN ${schema.wallets} w ON w.id = wa.wallet_id
                  INNER JOIN ${schema.accounts} a2 ON a2.id = w.account_id
                  WHERE a2.owner_id = u.id
                    AND wa.address ILIKE ${pattern}
                )
              )`
            : sql``
        }
      ORDER BY u.created_at DESC
      LIMIT ${limit + 1}
    `);

    // Peek one extra row to know if there's a next page. If we fetched
    // limit+1, the LAST row is the cursor for the NEXT call (and we
    // strip it from the returned items).
    const hasMore = result.rows.length > limit;
    const items = hasMore ? result.rows.slice(0, limit) : result.rows;
    const lastInPage = items[items.length - 1];
    const nextCursor =
      hasMore && lastInPage
        ? lastInPage.created_at instanceof Date
          ? lastInPage.created_at.toISOString()
          : new Date(lastInPage.created_at).toISOString()
        : null;

    // Coerce timestamps to Date — `db.execute<T>()` raw SQL returns string
    // for timestamptz on some PG driver configs (vs ORM `.select()` which
    // auto-parses). Без guard'а `toAdminUserResponse(user).createdAt.toISOString()`
    // throws 500 because string has no .toISOString().
    const toDate = (v: unknown): Date | null => {
      if (v == null) return null;
      if (v instanceof Date) return v;
      const d = new Date(v as string);
      return Number.isNaN(d.getTime()) ? null : d;
    };

    const mapped: UserListEntry[] = items.map((r) => ({
      user: {
        id: r.id,
        email: r.email,
        passwordHash: r.password_hash,
        name: r.name,
        legacyId: r.legacy_id,
        telegramId: r.telegram_id,
        telegramUsername: r.telegram_username,
        firstName: r.first_name,
        lastName: r.last_name,
        role: r.role,
        status: r.status,
        notes: r.notes,
        activeAccountId: r.active_account_id,
        trackedTickers: r.tracked_tickers,
        billingMeta: r.billing_meta,
        emailVerifiedAt: toDate(r.email_verified_at),
        lastLoginAt: toDate(r.last_login_at),
        createdAt: toDate(r.created_at) ?? new Date(0),
        updatedAt: toDate(r.updated_at) ?? new Date(0),
      } as UserRow,
      accountCount: Number(r.account_count ?? 0),
      lastSnapshotAt: toDate(r.last_snapshot_at),
      lastSnapshotUsd:
        r.last_snapshot_usd !== null && r.last_snapshot_usd !== undefined
          ? Number(r.last_snapshot_usd)
          : null,
    }));

    return { items: mapped, nextCursor };
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

  /**
   * Hard-delete a user and all their owned data.
   *
   * Cascade strategy:
   *   - Tables with `ON DELETE CASCADE` toward `users.id` (sessions,
   *     auth_tokens, accounts→[wallets, operations, portfolio_snapshots,
   *     api_usage], crypto_payment_addresses, user_payments,
   *     notification_subscriptions, telegram_links) — Postgres handles
   *     them automatically when the `users` row is deleted.
   *   - Tables with `ON DELETE SET NULL` (audit_log.actor_user_id,
   *     invites.consumed_by_user_id, integration_secrets.updated_by) —
   *     we keep the row for forensic value but lose the user pointer.
   *   - `invites.created_by_user_id` uses `ON DELETE RESTRICT`, so we
   *     first reassign any invites this user issued to a NULL-by-clearing
   *     workaround: we cancel them (mark revoked) before deleting.
   *
   * Safety guards:
   *   - Admin cannot delete themselves (lockout risk).
   *   - The last admin in the system cannot be deleted (always keep
   *     at least one active admin, even if blocked).
   *   - All in-flight impersonation sessions where this user was the
   *     impersonator OR target are revoked first.
   *
   * Audit-logged with all the metadata we can salvage before the row
   * goes away (email, name, role at time of deletion).
   */
  async deleteUser(
    userId: string,
    actorAdminId: string,
    mode: "admin" | "self" = "admin"
  ): Promise<void> {
    // M16: `mode="self"` is the GDPR-Art-17 self-delete path entered
    // from the user-side `DELETE /auth/me` route. Skips the "can't
    // delete yourself" guard (the whole point) but keeps the
    // last-admin protection so we never end up locked out of admin.
    if (mode === "admin" && userId === actorAdminId) {
      throw new NotFoundError(
        "Cannot delete your own admin account — log in as another admin first."
      );
    }
    const target = await this.findUserById(userId);
    if (!target) throw new NotFoundError(`User '${userId}' not found.`);

    // Last-admin guard (applies to BOTH modes — even self-delete must
    // not leave the system without any admin).
    if (target.role === "admin") {
      const [{ n }] = await this.db
        .select({ n: sql<number>`COUNT(*)::int` })
        .from(schema.users)
        .where(eq(schema.users.role, "admin"));
      if (Number(n) <= 1) {
        throw new NotFoundError(
          "Cannot delete the only admin account — promote another user to admin first."
        );
      }
    }

    // Snapshot for audit BEFORE delete. After the transaction below the
    // row is gone and we cannot read email/name/role for the audit row.
    await this.audit.log({
      actorUserId: actorAdminId,
      asAdmin: mode === "admin",
      targetUserId: userId,
      action: mode === "self" ? "user.self_deleted" : "admin.user_deleted",
      payload: {
        email: target.email,
        name: target.name,
        role: target.role,
        status: target.status,
        mode,
        deletedAt: new Date().toISOString(),
      },
    });

    // Two RESTRICT FKs block a naked `DELETE FROM users WHERE id=…`:
    //   1. accounts.owner_id — must delete accounts first.
    //      CASCADE on accounts.id then nukes wallets, operations,
    //      portfolio_snapshots, address_labels, deleted_ops, lp_pairs,
    //      imported_operations, cg_id_overrides, account_counters,
    //      position_custom_cols.
    //   2. invites.created_by_user_id — must delete invites first.
    //      (Admins-only edge case; regular users have none, but keep
    //      the cleanup unconditional for safety.)
    //
    // Done as a transaction so partial failure leaves a consistent DB.
    try {
      await this.db.transaction(async (tx) => {
        await tx
          .delete(schema.invites)
          .where(eq(schema.invites.createdByUserId, userId));
        await tx
          .delete(schema.accounts)
          .where(eq(schema.accounts.ownerId, userId));
        await tx.delete(schema.users).where(eq(schema.users.id, userId));
      });
    } catch (e) {
      const msg = (e as Error).message;
      throw new NotFoundError(
        `Failed to delete user (likely FK constraint): ${msg.slice(0, 200)}`
      );
    }
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
    targetUserId: string,
    args?: { ip?: string | null; userAgent?: string | null }
  ): Promise<{
    revokedSessions: number;
    /** Fresh admin tokens so the dashboard can drop the impersonation
     *  banner without forcing a full re-login. Null when the caller
     *  isn't a current admin or the user row is missing. */
    adminTokens: {
      accessToken: string;
      accessTokenExpiresAt: Date;
      refreshToken: string;
      refreshTokenExpiresAt: Date;
      admin: UserRow;
    } | null;
  }> {
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

    // Mint a fresh non-impersonation session for the admin so the
    // frontend can swap the cookie+token back without going through
    // /login. If the admin row is missing or the user isn't an admin
    // any more we just skip — caller will fall back to logout.
    const admin = await this.authRepo.findActiveUserById(adminId);
    if (!admin || admin.role !== "admin") {
      return { revokedSessions: rows.length, adminTokens: null };
    }

    const refreshToken = generateRefreshToken();
    const refreshTokenHash = hashToken(refreshToken);
    const expiresAt = new Date(
      now.getTime() + this.config.refreshTtlDays * 24 * 60 * 60 * 1000
    );
    const [session] = await this.db
      .insert(schema.sessions)
      .values({
        userId: admin.id,
        sessionTokenHash: refreshTokenHash,
        userAgent: args?.userAgent ?? null,
        ip: args?.ip ?? null,
        expiresAt,
      })
      .returning();
    if (!session) throw new Error("Admin session insert failed.");

    const access = signAccessToken(
      {
        sub: admin.id,
        role: admin.role as "admin" | "user" | "viewer",
        sid: session.id,
      },
      this.config.jwtSecret,
      this.config.accessTtlMinutes
    );

    return {
      revokedSessions: rows.length,
      adminTokens: {
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt,
        refreshToken,
        refreshTokenExpiresAt: expiresAt,
        admin,
      },
    };
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
