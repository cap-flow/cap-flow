import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../core/errors.js";
import type { AccountsRepository } from "../accounts/accounts.repository.js";
import type { AuditService } from "../audit/audit.service.js";
import type { AuthTokensBundle } from "../auth/auth.service.js";
import type { IAuthRepository } from "../auth/auth.repository.js";
import { hashPassword } from "../auth/password.js";
import {
  generateInviteToken,
  generateRefreshToken,
  hashToken,
  signAccessToken,
} from "../auth/tokens.js";
import type { NotificationsService } from "../notifications/notifications.service.js";
import type { EmailVerificationService } from "../auth/email-verification.service.js";

import type {
  IInvitesRepository,
  InviteRow,
  InviteStatus,
} from "./invites.repository.js";

export interface InvitesConfig {
  readonly defaultTtlHours: number;
  readonly inviteBaseUrl: string;
  readonly jwtSecret: string;
  readonly accessTtlMinutes: number;
  readonly refreshTtlDays: number;
}

export interface CreateInviteParams {
  /**
   * Optional. When omitted, invite link is "open" — recipient enters
   * their own email at /invite/:token. Recommended flow for Phase S7+.
   */
  readonly email?: string | undefined;
  readonly ttlHours?: number | undefined;
  readonly notes?: string | undefined;
  readonly createdByUserId: string;
}

export interface InviteCreatedResult {
  readonly invite: InviteRow;
  readonly rawToken: string;
  readonly inviteUrl: string;
}

export interface RegisterParams {
  readonly token: string;
  /**
   * Required only if invite was created without a pre-bound email (open
   * invite link). Ignored otherwise — server uses invite.email.
   */
  readonly email?: string | undefined;
  readonly password: string;
  /** Optional display name. Falls back to email-local-part if empty. */
  readonly name?: string | undefined;
  readonly userAgent: string | null;
  readonly ip: string | null;
}

export class InvitesService {
  constructor(
    private readonly invites: IInvitesRepository,
    private readonly auth: IAuthRepository,
    private readonly accounts: AccountsRepository,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly config: InvitesConfig,
    /**
     * B4: optional email-verification trigger. When provided, registration
     * via invite immediately mints+sends a verify email so the user lands
     * in their inbox with a confirm link. If unavailable (e.g. tests),
     * registration still succeeds — verification can be triggered later
     * from POST /auth/email-verification/send.
     */
    private readonly emailVerification?: EmailVerificationService
  ) {}

  async createInvite(p: CreateInviteParams): Promise<InviteCreatedResult> {
    const email = p.email ? p.email.toLowerCase() : null;
    const now = new Date();

    // Email-bound flow: extra checks. Open invite (no email) skips these
    // — admin gets a generic link to forward, and the recipient is
    // identified at registration time.
    if (email) {
      const existing = await this.auth.findUserByEmail(email);
      if (existing) {
        throw new ConflictError(
          `User with email '${email}' already exists. Use password reset instead.`
        );
      }
      const pending = await this.invites.pendingByEmail(email);
      for (const inv of pending) {
        if (inv.expiresAt.getTime() < now.getTime()) continue;
        await this.invites.revoke(inv.id, now);
      }
    }

    const ttlHours = p.ttlHours ?? this.config.defaultTtlHours;
    const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);
    const rawToken = generateInviteToken();
    const tokenHash = hashToken(rawToken);

    const invite = await this.invites.create({
      email,
      tokenHash,
      createdByUserId: p.createdByUserId,
      expiresAt,
      notes: p.notes ?? null,
    });

    await this.audit.log({
      actorUserId: p.createdByUserId,
      action: "invite.created",
      target: email ?? `open-link:${invite.id}`,
      payload: {
        inviteId: invite.id,
        expiresAt: expiresAt.toISOString(),
        kind: email ? "email-bound" : "open-link",
      },
    });

    const inviteUrl = `${this.config.inviteBaseUrl}/${rawToken}`;

    // Email delivery only when we have an address. Open links are
    // forwarded by the admin manually — that's the whole point.
    if (email) {
      try {
        await this.notifications.sendInvite(email, inviteUrl, null);
      } catch {
        /* notifications-service writes its own audit row; swallow */
      }
    }

    return { invite, rawToken, inviteUrl };
  }

  async listInvites(filter: {
    status?: InviteStatus | undefined;
  }): Promise<InviteRow[]> {
    await this.invites.markExpired(new Date()); // lazy expiry sweep
    return this.invites.listAll({ status: filter.status });
  }

  async revokeInvite(id: string, actorUserId: string): Promise<InviteRow> {
    const row = await this.invites.findById(id);
    if (!row) throw new NotFoundError(`Invite '${id}' not found.`);
    if (row.status !== "pending") {
      throw new ConflictError(
        `Invite is already ${row.status}; cannot revoke.`
      );
    }
    const now = new Date();
    await this.invites.revoke(id, now);
    await this.audit.log({
      actorUserId,
      action: "invite.revoked",
      target: row.email,
      payload: { inviteId: id },
    });
    const updated = await this.invites.findById(id);
    return updated!;
  }

  /** Public: validate a raw token, return safe public-facing info. */
  async previewByToken(rawToken: string): Promise<{
    email: string | null;
    expiresAt: Date;
    notes: string | null;
  }> {
    const invite = await this.findValidPendingInvite(rawToken);
    return {
      email: invite.email,
      expiresAt: invite.expiresAt,
      notes: invite.notes,
    };
  }

  /**
   * Public: complete registration from invite.
   *
   * NOT wrapped in a single transaction — if a step fails between user
   * creation and invite consumption, the invite may end up in an inconsistent
   * state. Accepted as a Phase 1 trade-off; Phase 2 (when we add proper
   * tx-aware repos) will wrap this end-to-end.
   */
  async registerByToken(p: RegisterParams): Promise<AuthTokensBundle> {
    const invite = await this.findValidPendingInvite(p.token);

    // Email resolution:
    //   - email-bound invite → server-trusted invite.email
    //   - open invite → user-supplied p.email (validated by zod upstream)
    const resolvedEmail = invite.email ?? p.email?.toLowerCase().trim();
    if (!resolvedEmail) {
      throw new ConflictError(
        "Email is required for this open invite link."
      );
    }

    // Defensive: someone might race to register the same email via another
    // invite or via a future signup endpoint.
    const dupe = await this.auth.findUserByEmail(resolvedEmail);
    if (dupe) {
      throw new ConflictError(
        `User with email '${resolvedEmail}' already exists.`
      );
    }

    const passwordHash = await hashPassword(p.password);
    // Display name: explicit > email-local-part. Lets the registration
    // form skip the name field entirely for the simplest UX.
    const displayName =
      p.name?.trim() || resolvedEmail.split("@")[0] || resolvedEmail;
    const newUser = await this.auth.createUser({
      email: resolvedEmail,
      name: displayName,
      passwordHash,
      role: "user",
    });

    // Primary account (1-per-user on beta — admin tweaks later).
    await this.accounts.createPrimary({
      ownerId: newUser.id,
      name: "Main",
      description: null,
    });

    const now = new Date();
    await this.invites.consume(invite.id, newUser.id, now);
    await this.audit.log({
      actorUserId: newUser.id,
      action: "invite.consumed",
      target: resolvedEmail,
      payload: {
        inviteId: invite.id,
        kind: invite.email ? "email-bound" : "open-link",
      },
    });
    await this.audit.log({
      actorUserId: newUser.id,
      action: "user.registered",
      target: resolvedEmail,
      payload: { source: "invite", inviteId: invite.id },
    });

    // B4: mint + send an email verification link right after signup.
    // Best-effort: failure here MUST NOT block registration — user can
    // request a resend after login via POST /auth/email-verification/send.
    if (this.emailVerification) {
      try {
        const issued = await this.emailVerification.issueToken(newUser.id);
        if (!issued.alreadyVerified && issued.url) {
          await this.notifications.sendEmailVerification(newUser, issued.url);
        }
      } catch (e) {
        // Log to audit so we can spot delivery failures during rollout;
        // never throw — registration must remain transactional.
        await this.audit.log({
          actorUserId: newUser.id,
          action: "email_verification.send_failed",
          target: resolvedEmail,
          payload: {
            inviteId: invite.id,
            error: (e as Error).message.slice(0, 500),
          },
        });
      }
    }

    // Auto-login: create session + tokens via the same primitives auth uses.
    const refreshToken = generateRefreshToken();
    const refreshTokenHash = hashToken(refreshToken);
    const refreshExpires = new Date(
      now.getTime() + this.config.refreshTtlDays * 24 * 60 * 60 * 1000
    );
    const session = await this.auth.createSession({
      userId: newUser.id,
      sessionTokenHash: refreshTokenHash,
      userAgent: p.userAgent,
      ip: p.ip,
      expiresAt: refreshExpires,
    });
    await this.auth.touchUserLastLogin(newUser.id, now);

    const access = signAccessToken(
      { sub: newUser.id, role: "user", sid: session.id },
      this.config.jwtSecret,
      this.config.accessTtlMinutes
    );

    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken,
      refreshTokenExpiresAt: refreshExpires,
      user: newUser,
    };
  }

  // ─── helpers ─────────────────────────────────────────────────────────

  private async findValidPendingInvite(rawToken: string): Promise<InviteRow> {
    const tokenHash = hashToken(rawToken);
    const invite = await this.invites.findByTokenHash(tokenHash);
    if (!invite) throw new NotFoundError("Invite not found.");

    if (invite.status === "consumed") {
      throw new ForbiddenError("This invite has already been used.");
    }
    if (invite.status === "revoked") {
      throw new ForbiddenError("This invite has been revoked.");
    }
    if (invite.status === "expired" || invite.expiresAt.getTime() < Date.now()) {
      // Lazy mark as expired on read so admin list reflects reality.
      if (invite.status === "pending") {
        await this.invites.markExpired(new Date());
      }
      throw new ForbiddenError("This invite has expired.");
    }
    return invite;
  }
}

