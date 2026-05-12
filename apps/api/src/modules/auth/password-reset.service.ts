import { UnauthorizedError } from "../../core/errors.js";
import type { AuditService } from "../audit/audit.service.js";
import type { NotificationsService } from "../notifications/notifications.service.js";

import { hashPassword } from "./password.js";
import type { IAuthRepository } from "./auth.repository.js";
import type { IPasswordResetRepository } from "./password-reset.repository.js";
import { generateInviteToken, hashToken } from "./tokens.js";

export interface PasswordResetConfig {
  readonly resetTtlMinutes: number;
  readonly resetBaseUrl: string;
}

export interface RequestResetResult {
  /** True if the email matched a user. Phase 7 actually emails the link
   *  via NotificationsService (Resend or stdout-stub). Caller still
   *  returns 204 regardless — no enumeration. */
  readonly issued: boolean;
  readonly rawToken?: string;
  readonly resetUrl?: string;
}

export class PasswordResetService {
  constructor(
    private readonly auth: IAuthRepository,
    private readonly tokens: IPasswordResetRepository,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly config: PasswordResetConfig
  ) {}

  async requestReset(email: string): Promise<RequestResetResult> {
    const user = await this.auth.findUserByEmail(email);
    if (!user || user.status !== "active") {
      return { issued: false }; // caller still returns 204
    }
    const rawToken = generateInviteToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(
      Date.now() + this.config.resetTtlMinutes * 60 * 1000
    );
    await this.tokens.create({
      userId: user.id,
      tokenHash,
      expiresAt,
    });
    const resetUrl = `${this.config.resetBaseUrl}/${rawToken}`;
    await this.audit.log({
      actorUserId: user.id,
      action: "password.reset_requested",
      target: email,
      payload: { expiresAt: expiresAt.toISOString() },
    });

    // Transactional: bypass subscription opt-out. NotificationsService
    // routes through Resend if configured, otherwise prints to stdout —
    // same observable surface either way.
    await this.notifications.sendPasswordReset(user, resetUrl);

    return { issued: true, rawToken, resetUrl };
  }

  async confirmReset(rawToken: string, newPassword: string): Promise<void> {
    const tokenHash = hashToken(rawToken);
    const row = await this.tokens.findActiveByHash(tokenHash);
    if (!row) throw new UnauthorizedError("Invalid or used token.");
    if (row.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedError("Token expired.");
    }
    const passwordHash = await hashPassword(newPassword);
    const now = new Date();
    await this.auth.setPasswordHash(row.userId, passwordHash);
    await this.tokens.consume(row.id, now);
    const revokedCount = await this.tokens.revokeAllSessionsForUser(
      row.userId,
      now
    );
    await this.audit.log({
      actorUserId: row.userId,
      action: "password.reset_confirmed",
      payload: { revokedSessions: revokedCount },
    });
  }
}
