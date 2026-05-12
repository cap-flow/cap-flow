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
  readonly email: string;
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
  readonly password: string;
  readonly name: string;
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
    private readonly config: InvitesConfig
  ) {}

  async createInvite(p: CreateInviteParams): Promise<InviteCreatedResult> {
    const email = p.email.toLowerCase();

    // 1. Already a user with this email? — refuse, admin should reset their password instead.
    const existing = await this.auth.findUserByEmail(email);
    if (existing) {
      throw new ConflictError(
        `User with email '${email}' already exists. Use password reset instead.`
      );
    }

    // 2. Already a pending invite? — revoke it; only one live invite per email.
    const pending = await this.invites.pendingByEmail(email);
    const now = new Date();
    for (const inv of pending) {
      if (inv.expiresAt.getTime() < now.getTime()) continue;
      await this.invites.revoke(inv.id, now);
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
      target: email,
      payload: { inviteId: invite.id, expiresAt: expiresAt.toISOString() },
    });

    const inviteUrl = `${this.config.inviteBaseUrl}/${rawToken}`;

    // Send the invite email. The admin response *also* contains the URL,
    // so a manual hand-off path always works even if Resend is unconfigured
    // — the email is for convenience, not a hard requirement.
    try {
      await this.notifications.sendInvite(email, inviteUrl, null);
    } catch {
      // Audit row was already written by notifications service; swallow so
      // the admin's POST still succeeds — they still have the URL to
      // forward by hand.
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
    email: string;
    expiresAt: Date;
  }> {
    const invite = await this.findValidPendingInvite(rawToken);
    return { email: invite.email, expiresAt: invite.expiresAt };
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

    // Defensive: someone might race to register the same email via another invite.
    const dupe = await this.auth.findUserByEmail(invite.email);
    if (dupe) {
      throw new ConflictError(
        `User with email '${invite.email}' already exists.`
      );
    }

    const passwordHash = await hashPassword(p.password);
    const newUser = await this.auth.createUser({
      email: invite.email,
      name: p.name,
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
      target: invite.email,
      payload: { inviteId: invite.id },
    });
    await this.audit.log({
      actorUserId: newUser.id,
      action: "user.registered",
      target: invite.email,
      payload: { source: "invite", inviteId: invite.id },
    });

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

