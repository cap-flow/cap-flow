import type { AuditService } from "../audit/audit.service.js";
import type { UserRow } from "../auth/auth.repository.js";
import type { TelegramService } from "../telegram/telegram.service.js";

import type { EmailClient, EmailMessage } from "./email-client.js";
import type { NotificationSubscriptionsRepository } from "./notification-subscriptions.repository.js";

export interface SendArgs {
  readonly user: UserRow;
  readonly type: string;
  readonly subject: string;
  readonly bodyText: string;
  readonly bodyHtml?: string;
  /** When true, ignore subscriptions table (e.g. password reset must go). */
  readonly transactional?: boolean;
}

export interface SendResult {
  readonly emailSent: boolean;
  readonly telegramSent: boolean;
  readonly skippedReasons: string[];
}

/**
 * Single façade for all outbound notifications.
 *
 * Routing rules:
 *   - email: if `subscriptions.isEnabled(user, type, 'email')` (or
 *     `transactional`) and user has a non-empty email → call EmailClient.
 *   - telegram: same gate; goes through TelegramService (which itself
 *     no-ops if the user hasn't linked their account or the bot isn't
 *     hosted yet).
 *
 * Every send result is recorded in `audit_log` so the admin can answer
 * "did we email Alice about the reset?".
 */
export class NotificationsService {
  constructor(
    private readonly email: EmailClient,
    private readonly telegram: TelegramService,
    private readonly subs: NotificationSubscriptionsRepository,
    private readonly audit: AuditService
  ) {}

  async send(args: SendArgs): Promise<SendResult> {
    const skipped: string[] = [];
    let emailSent = false;
    let telegramSent = false;

    if (args.user.email) {
      const ok =
        args.transactional ||
        (await this.subs.isEnabled(args.user.id, args.type, "email"));
      if (ok) {
        const msg: EmailMessage = {
          to: args.user.email,
          subject: args.subject,
          text: args.bodyText,
          ...(args.bodyHtml ? { html: args.bodyHtml } : {}),
        };
        try {
          const r = await this.email.send(msg);
          emailSent = true;
          await this.audit.log({
            actorUserId: args.user.id,
            targetUserId: args.user.id,
            action: "notification.email_sent",
            target: args.user.email,
            payload: {
              type: args.type,
              mode: r.mode,
              messageId: r.messageId,
              subject: args.subject,
            },
          });
        } catch (err) {
          const msgErr = err instanceof Error ? err.message : String(err);
          skipped.push(`email: ${msgErr.slice(0, 200)}`);
          await this.audit.log({
            actorUserId: args.user.id,
            targetUserId: args.user.id,
            action: "notification.email_failed",
            target: args.user.email,
            payload: { type: args.type, error: msgErr.slice(0, 500) },
          });
        }
      } else {
        skipped.push("email: subscription disabled");
      }
    } else {
      skipped.push("email: user has no address");
    }

    // Telegram: ignored when subscriptions table says no, OR the user
    // hasn't completed `/start <code>` yet. TelegramService.send is the
    // place where "no link → no-op" lives.
    const tgOk =
      args.transactional ||
      (await this.subs.isEnabled(args.user.id, args.type, "telegram"));
    if (tgOk) {
      try {
        const sent = await this.telegram.send(
          args.user.id,
          args.bodyText
        );
        telegramSent = sent;
        if (!sent) skipped.push("telegram: user not linked");
        await this.audit.log({
          actorUserId: args.user.id,
          targetUserId: args.user.id,
          action: sent ? "notification.telegram_sent" : "notification.telegram_skipped",
          payload: { type: args.type },
        });
      } catch (err) {
        const msgErr = err instanceof Error ? err.message : String(err);
        skipped.push(`telegram: ${msgErr.slice(0, 200)}`);
      }
    } else {
      skipped.push("telegram: subscription disabled");
    }

    return { emailSent, telegramSent, skippedReasons: skipped };
  }

  // Convenience helpers for the common transactional flows. ──────────

  async sendPasswordReset(user: UserRow, resetUrl: string): Promise<SendResult> {
    return this.send({
      user,
      type: "password_reset",
      subject: "Сброс пароля Capflow",
      bodyText:
        `Здравствуйте!\n\n` +
        `Кто-то запросил сброс пароля для вашего аккаунта в Capflow.\n` +
        `Если это вы — перейдите по ссылке (действительна 60 минут):\n\n` +
        `${resetUrl}\n\n` +
        `Если это были не вы — просто игнорируйте письмо.`,
      transactional: true,
    });
  }

  async sendEmailVerification(
    user: UserRow,
    verifyUrl: string
  ): Promise<SendResult> {
    return this.send({
      user,
      type: "email_verification",
      subject: "Подтвердите ваш email — Capflow",
      bodyText:
        `Здравствуйте!\n\n` +
        `Чтобы завершить регистрацию в Capflow, подтвердите этот email — ` +
        `перейдите по ссылке (действительна 24 часа):\n\n` +
        `${verifyUrl}\n\n` +
        `После подтверждения вы получите доступ ко всем функциям ` +
        `(в т.ч. восстановление пароля и уведомления о платежах).\n\n` +
        `Если вы не регистрировались — просто игнорируйте письмо.`,
      transactional: true,
    });
  }

  async sendInvite(
    invitedEmail: string,
    inviteUrl: string,
    inviterName: string | null
  ): Promise<SendResult> {
    // Invites go to addresses that may not yet be a user row — build a
    // minimal stub so the email path runs without DB writes.
    const stub: UserRow = {
      id: "00000000-0000-0000-0000-000000000000",
      email: invitedEmail,
      passwordHash: null,
      name: null,
      legacyId: null,
      telegramId: null,
      telegramUsername: null,
      firstName: null,
      lastName: null,
      username: null,
      role: "user",
      status: "active",
      notes: null,
      activeAccountId: null,
      trackedTickers: [],
      billingMeta: null,
      lotMethodology: null,
      emailVerifiedAt: null,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const body =
      (inviterName ? `${inviterName} пригласил вас в Capflow.\n\n` : "") +
      `Откройте ссылку чтобы создать пароль и войти:\n\n${inviteUrl}\n\n` +
      `Ссылка действует ограниченное время. Передавать её другим бессмысленно — ` +
      `регистрация привязана к вашему email.`;
    return this.send({
      user: stub,
      type: "invite",
      subject: "Приглашение в Capflow",
      bodyText: body,
      transactional: true,
    });
  }
}
