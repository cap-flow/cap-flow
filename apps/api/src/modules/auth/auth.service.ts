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
    const session = await this.repo.findActiveSessionByTokenHash(tokenHash);
    if (!session) throw new UnauthorizedError("Refresh session not found.");
    if (session.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedError("Refresh session expired.");
    }
    const user = await this.repo.findActiveUserById(session.userId);
    if (!user) throw new UnauthorizedError("User no longer active.");

    const now = new Date();

    // Rotation: revoke old, mint new. Limits replay if a refresh token leaks.
    await this.repo.revokeSession(session.id, now);

    const newRefreshToken = generateRefreshToken();
    const newRefreshTokenHash = hashToken(newRefreshToken);
    const newRefreshExpires = new Date(
      now.getTime() + this.config.refreshTtlDays * 24 * 60 * 60 * 1000
    );
    const newSession = await this.repo.createSession({
      userId: user.id,
      sessionTokenHash: newRefreshTokenHash,
      userAgent: meta.userAgent,
      ip: meta.ip,
      expiresAt: newRefreshExpires,
    });

    const access = signAccessToken(
      { sub: user.id, role: user.role as UserRole, sid: newSession.id },
      this.config.jwtSecret,
      this.config.accessTtlMinutes
    );

    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: newRefreshToken,
      refreshTokenExpiresAt: newRefreshExpires,
      user,
    };
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    const session = await this.repo.findActiveSessionByTokenHash(
      hashToken(refreshToken)
    );
    if (!session) return;
    await this.repo.revokeSession(session.id, new Date());
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
