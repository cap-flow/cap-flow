import { UnauthorizedError } from "../../core/errors.js";
import type { AuditService } from "../audit/audit.service.js";

import type { IAuthRepository, UserRow } from "./auth.repository.js";
import { hashPassword, verifyPassword } from "./password.js";
import {
  generateRefreshToken,
  hashToken,
  signAccessToken,
} from "./tokens.js";
import type { UserRole } from "./auth.types.js";

export interface AuthConfig {
  readonly jwtSecret: string;
  readonly accessTtlMinutes: number;
  readonly refreshTtlDays: number;
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly userAgent: string | null;
  readonly ip: string | null;
}

export interface AuthTokensBundle {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
  readonly user: UserRow;
  /** Present when the underlying session is an impersonation one, so
   *  the /refresh route can keep the dashboard banner alive across
   *  page reloads. */
  readonly impersonation?: {
    readonly impersonatorId: string;
    readonly mode: "view" | "edit";
  };
}

/** Dummy argon2 hash used to keep login response time constant when the
 *  email is unknown (defense against user enumeration). */
const DUMMY_HASH =
  "$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export class AuthService {
  constructor(
    private readonly repo: IAuthRepository,
    private readonly audit: AuditService,
    private readonly config: AuthConfig
  ) {}

  async login(input: LoginInput): Promise<AuthTokensBundle> {
    const email = input.email.toLowerCase();
    const user = await this.repo.findActiveUserByEmail(email);
    const ok = await verifyPassword(
      input.password,
      user?.passwordHash ?? DUMMY_HASH
    );
    if (!user || !user.passwordHash || !ok) {
      throw new UnauthorizedError("Invalid email or password.");
    }

    const now = new Date();
    const refreshToken = generateRefreshToken();
    const refreshTokenHash = hashToken(refreshToken);
    const refreshExpires = new Date(
      now.getTime() + this.config.refreshTtlDays * 24 * 60 * 60 * 1000
    );

    const session = await this.repo.createSession({
      userId: user.id,
      sessionTokenHash: refreshTokenHash,
      userAgent: input.userAgent,
      ip: input.ip,
      expiresAt: refreshExpires,
    });

    const access = signAccessToken(
      { sub: user.id, role: user.role as UserRole, sid: session.id },
      this.config.jwtSecret,
      this.config.accessTtlMinutes
    );

    await this.repo.touchUserLastLogin(user.id, now);
    await this.audit.log({
      actorUserId: user.id,
      action: "auth.login",
      ip: input.ip,
      userAgent: input.userAgent,
      payload: { sessionId: session.id },
    });

    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken,
      refreshTokenExpiresAt: refreshExpires,
      user,
    };
  }

  async refresh(
    refreshToken: string,
    meta: { userAgent: string | null; ip: string | null }
  ): Promise<AuthTokensBundle> {
    const tokenHash = hashToken(refreshToken);
    // H1: look up the session even if it was already revoked, so we can
    // distinguish "this token was rotated already (= reuse, possibly a
    // stolen-token attack)" from "this token never existed".
    const session = await this.repo.findAnySessionByTokenHash(tokenHash);
    if (!session) throw new UnauthorizedError("Refresh session not found.");

    if (session.revokedAt) {
      // The token was already consumed (either by rotation, logout, or
      // admin action). If it was rotated, the legitimate user has
      // already moved on to a fresh token — anyone presenting THIS one
      // again is either an attacker replaying a stolen token or the
      // legitimate user via an out-of-sync tab/cache. Either way the
      // safe response is to revoke the entire family: legitimate user
      // re-authenticates with password, attacker is locked out.
      if (session.revokedReason === "rotated" && session.familyId) {
        const n = await this.repo.revokeSessionFamily(
          session.familyId,
          new Date(),
          "reuse_detected"
        );
        await this.audit.log({
          actorUserId: session.userId,
          action: "auth.refresh_reuse_detected",
          ip: meta.ip,
          userAgent: meta.userAgent,
          payload: {
            sessionId: session.id,
            familyId: session.familyId,
            revokedCount: n,
          },
        });
      }
      throw new UnauthorizedError("Refresh session no longer valid.");
    }

    if (session.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedError("Refresh session expired.");
    }
    const user = await this.repo.findActiveUserById(session.userId);
    if (!user) throw new UnauthorizedError("User no longer active.");

    const now = new Date();

    // Rotation: revoke old with reason="rotated" so reuse-detection knows
    // this was a legitimate consumption (not a logout). Mint new in the
    // same family so the chain stays linkable.
    await this.repo.revokeSession(session.id, now, "rotated");

    const newRefreshToken = generateRefreshToken();
    const newRefreshTokenHash = hashToken(newRefreshToken);
    // Preserve impersonation context across rotation. Before this fix,
    // refresh dropped impersonatedById — after the first access token
    // expired the admin's impersonation effectively "graduated" into
    // the target user's real session (banner gone, no way to exit,
    // session hijack risk). For impersonation sessions we keep the
    // same expiry as the original (limited to impersonation TTL); for
    // normal sessions we extend to the full refresh window.
    const isImpersonation = !!session.impersonatedById;
    const newRefreshExpires = isImpersonation
      ? session.expiresAt
      : new Date(now.getTime() + this.config.refreshTtlDays * 24 * 60 * 60 * 1000);
    const newSession = await this.repo.createSession({
      userId: user.id,
      sessionTokenHash: newRefreshTokenHash,
      userAgent: meta.userAgent,
      ip: meta.ip,
      expiresAt: newRefreshExpires,
      ...(session.familyId ? { familyId: session.familyId } : {}),
      ...(isImpersonation && session.impersonatedById
        ? {
            impersonatedById: session.impersonatedById,
            impersonationMode: session.impersonationMode ?? "view",
          }
        : {}),
    });

    const access = signAccessToken(
      { sub: user.id, role: user.role as UserRole, sid: newSession.id },
      this.config.jwtSecret,
      this.config.accessTtlMinutes
    );

    // L1 (2026-05-14): close audit-trail gap. Pre-L1 refresh-rotation
    // (the most frequent auth event — every ~15 min for active users)
    // emitted nothing. For SOC2 / 152-ФЗ compliance every security-
    // relevant event must be logged; for forensics ("where was this
    // user the last 24h?") the row makes the rotation chain visible.
    await this.audit.log({
      actorUserId: user.id,
      action: "auth.refresh_rotated",
      ip: meta.ip,
      userAgent: meta.userAgent,
      payload: {
        sessionId: newSession.id,
        parentSessionId: session.id,
        familyId: session.familyId ?? newSession.familyId ?? newSession.id,
      },
    });

    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: newRefreshToken,
      refreshTokenExpiresAt: newRefreshExpires,
      user,
      ...(isImpersonation && session.impersonatedById
        ? {
            impersonation: {
              impersonatorId: session.impersonatedById,
              mode: (session.impersonationMode ?? "view") as "view" | "edit",
            },
          }
        : {}),
    };
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    const session = await this.repo.findActiveSessionByTokenHash(
      hashToken(refreshToken)
    );
    if (!session) return;
    // H1: tag with explicit reason so reuse-detector doesn't trigger on
    // a legitimate logout if the token resurfaces somehow.
    await this.repo.revokeSession(session.id, new Date(), "logout");
    await this.audit.log({
      actorUserId: session.userId,
      action: "auth.logout",
      payload: { sessionId: session.id },
    });
  }

  async getActiveUser(id: string): Promise<UserRow | null> {
    return this.repo.findActiveUserById(id);
  }

  async hashPasswordForStorage(plain: string): Promise<string> {
    return hashPassword(plain);
  }
}
