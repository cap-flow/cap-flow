import { z } from "zod";

import { api } from "@/lib/api/client";

export const messageDirectionSchema = z.enum(["in", "out"]);
export type MessageDirection = z.infer<typeof messageDirectionSchema>;

export const messageTypeSchema = z.enum([
  "text",
  "photo",
  "document",
  "audio",
  "video",
  "voice",
  "sticker",
  "other",
]);
export type MessageType = z.infer<typeof messageTypeSchema>;

export const telegramMessageSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  direction: messageDirectionSchema,
  type: messageTypeSchema,
  text: z.string().nullable(),
  chatId: z.number(),
  telegramMsgId: z.number().nullable(),
  fileUrl: z.string().nullable(),
  fileName: z.string().nullable(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});
export type TelegramMessage = z.infer<typeof telegramMessageSchema>;

export const conversationSchema = z.object({
  userId: z.string().uuid(),
  lastText: z.string().nullable(),
  lastDirection: messageDirectionSchema,
  lastAt: z.string(),
  unreadCount: z.number(),
});
export type Conversation = z.infer<typeof conversationSchema>;

export const chatTemplateSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  body: z.string(),
  sortOrder: z.number(),
  createdBy: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ChatTemplate = z.infer<typeof chatTemplateSchema>;

export interface UpsertTemplateInput {
  readonly title: string;
  readonly body: string;
  readonly sortOrder?: number;
}

export const adminTelegramChatApi = {
  listConversations: () =>
    api.get(
      "/v1/admin/telegram-chat/conversations",
      z.array(conversationSchema),
    ),
  listMessages: (userId: string, opts?: { limit?: number; before?: string }) => {
    const p = new URLSearchParams();
    if (opts?.limit) p.set("limit", String(opts.limit));
    if (opts?.before) p.set("before", opts.before);
    const qs = p.toString();
    return api.get(
      `/v1/admin/telegram-chat/conversations/${userId}/messages${qs ? `?${qs}` : ""}`,
      z.array(telegramMessageSchema),
    );
  },
  sendMessage: (userId: string, text: string) =>
    api.post(
      `/v1/admin/telegram-chat/conversations/${userId}/messages`,
      { text },
      telegramMessageSchema,
    ),
  markRead: (userId: string) =>
    api.post(
      `/v1/admin/telegram-chat/conversations/${userId}/read`,
      undefined,
      z.object({ updated: z.number() }),
    ),
  unread: () =>
    api.get(
      "/v1/admin/telegram-chat/unread",
      z.object({ count: z.number() }),
    ),
  listTemplates: () =>
    api.get("/v1/admin/telegram-chat/templates", z.array(chatTemplateSchema)),
  createTemplate: (input: UpsertTemplateInput) =>
    api.post(
      "/v1/admin/telegram-chat/templates",
      input,
      chatTemplateSchema,
    ),
  updateTemplate: (id: string, input: Partial<UpsertTemplateInput>) =>
    api.patch(
      `/v1/admin/telegram-chat/templates/${id}`,
      input,
      chatTemplateSchema,
    ),
  deleteTemplate: (id: string) =>
    api.delete(
      `/v1/admin/telegram-chat/templates/${id}`,
      z.object({ deleted: z.boolean() }),
    ),
};
