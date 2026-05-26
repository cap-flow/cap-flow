/**
 * Tests для AdminTelegramChatService: sendMessage flow + edge cases.
 */
import { describe, expect, it, vi } from "vitest";

import { AdminTelegramChatService } from "./admin-telegram-chat.service.js";

const TG_LINK_ROW = {
  id: "lnk-1",
  userId: "u-1",
  startCodeHash: "h",
  status: "linked" as const,
  chatId: 12345,
  telegramUsername: "alice",
  linkedAt: new Date(),
  revokedAt: null,
  expiresAt: new Date(Date.now() + 86400_000),
  createdAt: new Date(),
};

const MSG_ROW = {
  id: "msg-1",
  userId: "u-1",
  chatId: 12345,
  direction: "out" as const,
  type: "text" as const,
  text: "hello",
  telegramMsgId: null,
  fileUrl: null,
  fileName: null,
  readAt: null,
  createdAt: new Date(),
};

function makeService(overrides: {
  link?: typeof TG_LINK_ROW | null;
  sendOk?: boolean;
  sendThrows?: boolean;
} = {}) {
  const repo = {
    findActiveByUser: vi.fn(async () =>
      "link" in overrides ? overrides.link : TG_LINK_ROW,
    ),
    saveMessage: vi.fn(async () => MSG_ROW),
    listConversations: vi.fn(async () => []),
    listMessages: vi.fn(async () => []),
    totalUnread: vi.fn(async () => 0),
    markRead: vi.fn(async () => 0),
  };
  const telegram = {
    sendToChat: vi.fn(async () => {
      if (overrides.sendThrows) throw new Error("API down");
      return overrides.sendOk ?? true;
    }),
  };
  const audit = { log: vi.fn(async () => {}) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new AdminTelegramChatService(repo as any, telegram as any, audit as any);
  return { svc, repo, telegram, audit };
}

describe("AdminTelegramChatService.sendMessage", () => {
  it("happy path: send + save + audit", async () => {
    const { svc, repo, telegram, audit } = makeService();
    const result = await svc.sendMessage({
      userId: "u-1",
      text: "  hello  ",
      adminUserId: "admin-1",
    });
    expect(result.id).toBe("msg-1");
    expect(telegram.sendToChat).toHaveBeenCalledWith(12345, "hello");
    expect(repo.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u-1",
        chatId: 12345,
        direction: "out",
        text: "hello",
        type: "text",
      }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "admin-1",
        action: "admin.telegram.message_sent",
      }),
    );
  });

  it("empty text → throws, не save", async () => {
    const { svc, repo, telegram } = makeService();
    await expect(
      svc.sendMessage({ userId: "u-1", text: "   ", adminUserId: "a" }),
    ).rejects.toThrow(/empty/);
    expect(telegram.sendToChat).not.toHaveBeenCalled();
    expect(repo.saveMessage).not.toHaveBeenCalled();
  });

  it("too long text → throws (Telegram 4096 limit)", async () => {
    const { svc } = makeService();
    await expect(
      svc.sendMessage({
        userId: "u-1",
        text: "x".repeat(4097),
        adminUserId: "a",
      }),
    ).rejects.toThrow(/4096/);
  });

  it("user без linked TG → throws, не send", async () => {
    const { svc, telegram } = makeService({ link: null });
    await expect(
      svc.sendMessage({ userId: "u-1", text: "hi", adminUserId: "a" }),
    ).rejects.toThrow(/no linked Telegram/);
    expect(telegram.sendToChat).not.toHaveBeenCalled();
  });

  it("Telegram API ок=false (no token) → throws, не save", async () => {
    const { svc, repo } = makeService({ sendOk: false });
    await expect(
      svc.sendMessage({ userId: "u-1", text: "hi", adminUserId: "a" }),
    ).rejects.toThrow(/not configured/);
    expect(repo.saveMessage).not.toHaveBeenCalled();
  });

  it("Telegram API throws → пропагирует, не save", async () => {
    const { svc, repo } = makeService({ sendThrows: true });
    await expect(
      svc.sendMessage({ userId: "u-1", text: "hi", adminUserId: "a" }),
    ).rejects.toThrow(/API down/);
    expect(repo.saveMessage).not.toHaveBeenCalled();
  });
});
