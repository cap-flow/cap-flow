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
import {
  chatEventBus,
  type ChatNewMessageEvent,
  type ChatReadEvent,
} from "./chat-events.bus.js";

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

  /**
   * GET /stream — Server-Sent Events для real-time updates.
   *
   * Браузер открывает EventSource → подписывается на:
   *   event: new-message  → broadcast'ит когда incoming/outgoing message
   *   event: read         → broadcast'ит когда admin clear'ит unread
   *   event: ping (30s)   → keep-alive чтобы прокси/balancers не убили connection
   *
   * Browser auto-reconnects при разрыве — robust enough для production
   * без custom retry logic.
   */
  app.get(
    "/stream",
    {
      // Skip Zod response schema validation — SSE not JSON.
      // CSRF не нужен для GET через EventSource.
      config: { skipCsrf: true },
      preHandler: app.requireAdmin,
    },
    async (req, reply) => {
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no", // Disable nginx buffering.
      });
      const write = (event: string, data: unknown): void => {
        try {
          reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {
          /* connection closed — handled by close event below */
        }
      };
      // Initial ping чтобы client сразу видел connected state.
      write("ping", { t: Date.now() });

      const onMsg = (p: ChatNewMessageEvent): void => write("new-message", p);
      const onRead = (p: ChatReadEvent): void => write("read", p);
      chatEventBus.on("new-message", onMsg);
      chatEventBus.on("read", onRead);

      // Keep-alive ping каждые 30с (прокси типа nginx убивают idle через 60с).
      const pingInterval = setInterval(() => {
        try {
          reply.raw.write(`: ping\n\n`);
        } catch {
          /* handled by close */
        }
      }, 30_000);

      // Cleanup при disconnect (client tab close, network drop, server shutdown).
      const cleanup = (): void => {
        clearInterval(pingInterval);
        chatEventBus.off("new-message", onMsg);
        chatEventBus.off("read", onRead);
      };
      req.raw.on("close", cleanup);
      req.raw.on("error", cleanup);
    },
  );
}
