/**
 * Admin chat HTTP routes — admin↔user переписка через Telegram bot.
 *
 * Все routes требуют admin role (`app.requireAdmin`).
 *
 *   GET    /v1/admin/telegram-chat/conversations
 *   GET    /v1/admin/telegram-chat/conversations/:userId/messages?limit=&before=
 *   POST   /v1/admin/telegram-chat/conversations/:userId/messages   { text }
 *   POST   /v1/admin/telegram-chat/conversations/:userId/read
 *   GET    /v1/admin/telegram-chat/unread
 */

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { UnauthorizedError } from "../../core/errors.js";

import type { AdminTelegramChatService } from "./admin-telegram-chat.service.js";

const messageSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  direction: z.enum(["in", "out"]),
  type: z.enum([
    "text",
    "photo",
    "document",
    "audio",
    "video",
    "voice",
    "sticker",
    "other",
  ]),
  text: z.string().nullable(),
  chatId: z.number(),
  telegramMsgId: z.number().nullable(),
  fileUrl: z.string().nullable(),
  fileName: z.string().nullable(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});

const conversationSchema = z.object({
  userId: z.string().uuid(),
  lastText: z.string().nullable(),
  lastDirection: z.enum(["in", "out"]),
  lastAt: z.string(),
  unreadCount: z.number(),
});

interface RouteOpts {
  readonly service: AdminTelegramChatService;
}

export async function adminTelegramChatRoutes(
  app: FastifyInstance,
  opts: RouteOpts,
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAdmin);

  route.get(
    "/conversations",
    { schema: { response: { 200: z.array(conversationSchema) } } },
    async () => {
      const list = await opts.service.listConversations();
      return list.map((c) => ({
        ...c,
        lastAt: c.lastAt.toISOString(),
      }));
    },
  );

  route.get(
    "/unread",
    { schema: { response: { 200: z.object({ count: z.number() }) } } },
    async () => ({ count: await opts.service.totalUnread() }),
  );

  route.get(
    "/conversations/:userId/messages",
    {
      schema: {
        params: z.object({ userId: z.string().uuid() }),
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          before: z.string().datetime().optional(),
        }),
        response: { 200: z.array(messageSchema) },
      },
    },
    async (req) => {
      const before = req.query.before ? new Date(req.query.before) : undefined;
      const rows = await opts.service.listMessages({
        userId: req.params.userId,
        limit: req.query.limit,
        ...(before ? { before } : {}),
      });
      return rows.map((r) => ({
        ...r,
        readAt: r.readAt ? r.readAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
      }));
    },
  );

  route.post(
    "/conversations/:userId/messages",
    {
      schema: {
        params: z.object({ userId: z.string().uuid() }),
        body: z.object({ text: z.string().min(1).max(4096) }),
        response: { 200: messageSchema },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const row = await opts.service.sendMessage({
        userId: req.params.userId,
        text: req.body.text,
        adminUserId: u.id,
      });
      return {
        ...row,
        readAt: row.readAt ? row.readAt.toISOString() : null,
        createdAt: row.createdAt.toISOString(),
      };
    },
  );

  route.post(
    "/conversations/:userId/read",
    {
      schema: {
        params: z.object({ userId: z.string().uuid() }),
        response: { 200: z.object({ updated: z.number() }) },
      },
    },
    async (req) => {
      const updated = await opts.service.markRead(req.params.userId);
      return { updated };
    },
  );
}
