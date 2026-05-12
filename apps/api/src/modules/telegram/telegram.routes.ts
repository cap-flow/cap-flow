import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { UnauthorizedError } from "../../core/errors.js";

import type { TelegramService } from "./telegram.service.js";

const statusResponseSchema = z.object({
  state: z.enum(["linked", "pending", "none"]),
  chatId: z.number().nullable(),
  telegramUsername: z.string().nullable(),
  linkedAt: z.string().datetime().nullable(),
});

const startResponseSchema = z.object({
  code: z.string(),
  deepLink: z.string(),
  expiresAt: z.string().datetime(),
});

interface TelegramRoutesOptions {
  readonly service: TelegramService;
}

export async function telegramRoutes(
  app: FastifyInstance,
  opts: TelegramRoutesOptions
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAuth);

  route.get(
    "/",
    { schema: { response: { 200: statusResponseSchema } } },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const s = await opts.service.status(u.id);
      return {
        state: s.state,
        chatId: s.chatId,
        telegramUsername: s.telegramUsername,
        linkedAt: s.linkedAt ? s.linkedAt.toISOString() : null,
      };
    }
  );

  route.post(
    "/start",
    {
      schema: { response: { 200: startResponseSchema } },
      config: { rateLimit: { max: 5, timeWindow: "10 minutes" } },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const r = await opts.service.startLink(u.id);
      return {
        code: r.code,
        deepLink: r.deepLink,
        expiresAt: r.expiresAt.toISOString(),
      };
    }
  );

  route.delete(
    "/",
    {
      schema: { response: { 200: z.object({ revoked: z.number() }) } },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const revoked = await opts.service.unlink(u.id);
      return { revoked };
    }
  );
}
