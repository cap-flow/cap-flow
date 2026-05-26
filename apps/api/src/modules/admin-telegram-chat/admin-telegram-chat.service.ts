/**
 * Admin chat: business logic для admin↔user переписки через Telegram bot.
 *
 * Чтение messages (история, conversations list, unread) делегируется в
 * `TelegramRepository`. Send-side вызывает `TelegramService.sendToChat`
 * И затем сохраняет в БД с direction='out'.
 */

import type { AuditService } from "../audit/audit.service.js";
import type {
  TelegramRepository,
  TelegramMessageRow,
} from "../telegram/telegram.repository.js";
import type { TelegramService } from "../telegram/telegram.service.js";

export interface ConversationSummary {
  userId: string;
  lastText: string | null;
  lastDirection: "in" | "out";
  lastAt: Date;
  unreadCount: number;
}

export class AdminTelegramChatService {
  constructor(
    private readonly repo: TelegramRepository,
    private readonly telegram: TelegramService,
    private readonly audit: AuditService,
  ) {}

  listConversations(): Promise<ConversationSummary[]> {
    return this.repo.listConversations();
  }

  listMessages(args: {
    userId: string;
    limit: number;
    before?: Date;
  }): Promise<TelegramMessageRow[]> {
    return this.repo.listMessages(args);
  }

  totalUnread(): Promise<number> {
    return this.repo.totalUnread();
  }

  markRead(userId: string): Promise<number> {
    return this.repo.markRead(userId);
  }

  /**
   * Отправить text сообщение юзеру в TG bot. Throws если у юзера нет
   * linked chat_id ИЛИ Telegram API упал. Audit-логируется как
   * `admin.telegram.message_sent`.
   */
  async sendMessage(args: {
    userId: string;
    text: string;
    adminUserId: string;
  }): Promise<TelegramMessageRow> {
    const trimmed = args.text.trim();
    if (trimmed.length === 0) {
      throw new Error("Cannot send empty message");
    }
    if (trimmed.length > 4096) {
      throw new Error("Message exceeds Telegram 4096 char limit");
    }
    // Find linked chat_id для recipient.
    const link = await this.repo.findActiveByUser(args.userId);
    if (!link || !link.chatId) {
      throw new Error("User has no linked Telegram chat");
    }
    // Send through Telegram API. Throws on failure (caller will surface 500).
    const ok = await this.telegram.sendToChat(link.chatId, trimmed);
    if (!ok) {
      throw new Error("Telegram bot token not configured");
    }
    // Save в БД.
    const row = await this.repo.saveMessage({
      userId: args.userId,
      chatId: link.chatId,
      direction: "out",
      text: trimmed,
      type: "text",
    });
    await this.audit.log({
      actorUserId: args.adminUserId,
      action: "admin.telegram.message_sent",
      payload: {
        targetUserId: args.userId,
        msgLength: trimmed.length,
      },
    });
    return row;
  }
}
