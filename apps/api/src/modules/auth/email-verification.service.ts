import { ForbiddenError, NotFoundError } from "../../core/errors.js";

import type { IAuthRepository } from "./auth.repository.js";
import {
  generateRefreshToken as generateUrlSafeToken,
  hashToken,
} from "./tokens.js";

/**
 * Single row in the email-verification token store. Hashed token only — the
 * plaintext exists for ~24h in the user's email and never on disk.
 */
export interface VerifyTokenRow {
  readonly id: string;
  readonly tokenHash: string;
  readonly userId: string;
  readonly emailAtIssue: string;
  readonly expiresAt: Date;
  consumedAt: Date | null;
  readonly createdAt: Date;
}

export interface IEmailVerificationRepository {
  insert(
    input: Omit<VerifyTokenRow, "id" | "createdAt" | "consumedAt">
  ): Promise<VerifyTokenRow>;
  findByHash(tokenHash: string): Promise<VerifyTokenRow | null>;
  consume(id: string, at: Date): Promise<void>;
  /** Revoke any outstanding live tokens for a user. Used on re-issue. */
  revokeAllForUser(userId: string, at: Date): Promise<number>;
}

export interface EmailVerificationConfig {
  readonly ttlHours: number;
  readonly verifyBaseUrl: string;
}

export interface IssueResult {
  readonly alreadyVerified: boolean;
  /** Full URL with token in path. Null when alreadyVerified. */
  readonly url: string | null;
  /** Email the token is bound to (current users.email). */
  readonly email: string | null;
}

export interface ConfirmResult {
  readonly userId: string;
  readonly emailAtIssue: string;
  /** True if user's email was already verified earlier (token still consumed). */
  readonly wasAlreadyVerified: boolean;
}

/**
 * Email verification (B4).
 *
 * Workflow:
 *   1. `issueToken(userId)` mints a single-use, time-limited URL token
 *      and revokes any prior live tokens for the same user (re-issue is
 *      idempotent + safe).
 *   2. Token plaintext is delivered to the user via email; only its
 *      SHA-256 hash is persisted.
 *   3. `confirm(rawToken)` stamps `users.email_verified_at` and consumes
 *      the token. Replays are rejected at the consumed-at check.
 *
 * Distinct from `invites` (which create new accounts) and password-reset
 * (which authenticates an existing user). Same table family as both
 * (`auth_tokens`-style), but stored separately so the lifecycle logic
 * stays focused.
 */
export class EmailVerificationService {
  constructor(
    private readonly tokens: IEmailVerificationRepository,
    private readonly users: IAuthRepository,
    private readonly cfg: EmailVerificationConfig
  ) {}

  async issueToken(userId: string): Promise<IssueResult> {
    const user = await this.users.findUserById(userId);
    if (!user) throw new NotFoundError(`User '${userId}' not found.`);
    if (user.emailVerifiedAt) {
      return { alreadyVerified: true, url: null, email: user.email };
    }
    if (!user.email) {
      throw new ForbiddenError("User has no email to verify.");
    }
    const now = new Date();
    // Revoke any prior live tokens — only the latest URL should work.
    // Defense against accidental re-issue spam, and against a leaked
    // earlier link staying valid in the user's inbox after they trigger
    // a "resend".
    await this.tokens.revokeAllForUser(userId, now);

    const rawToken = generateUrlSafeToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(now.getTime() + this.cfg.ttlHours * 3600 * 1000);
    await this.tokens.insert({
      tokenHash,
      userId,
      emailAtIssue: user.email,
      expiresAt,
    });

    const baseUrl = this.cfg.verifyBaseUrl.replace(/\/$/, "");
    return {
      alreadyVerified: false,
      url: `${baseUrl}/${rawToken}`,
      email: user.email,
    };
  }

  async confirm(rawToken: string): Promise<ConfirmResult> {
    if (!rawToken || typeof rawToken !== "string") {
      throw new NotFoundError("Verification token not found.");
    }
    const tokenHash = hashToken(rawToken);
    const row = await this.tokens.findByHash(tokenHash);
    if (!row) throw new NotFoundError("Verification token not found.");
    if (row.consumedAt) {
      throw new ForbiddenError(
        "This verification link has already been used."
      );
    }
    if (row.expiresAt.getTime() < Date.now()) {
      throw new ForbiddenError("This verification link has expired.");
    }

    const now = new Date();
    const user = await this.users.findUserById(row.userId);
    const wasAlreadyVerified = !!user?.emailVerifiedAt;
    if (!wasAlreadyVerified) {
      await this.users.markEmailVerified(row.userId, now);
    }
    await this.tokens.consume(row.id, now);

    return {
      userId: row.userId,
      emailAtIssue: row.emailAtIssue,
      wasAlreadyVerified,
    };
  }
}
