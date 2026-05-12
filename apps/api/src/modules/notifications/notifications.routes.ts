import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { UnauthorizedError } from "../../core/errors.js";

import type { NotificationSubscriptionsRepository } from "./notification-subscriptions.repository.js";

const channelEnum = z.enum(["email", "telegram"]);

const subscriptionSchema = z.object({
  type: z.string().min(1).max(80),
  channel: channelEnum,
  enabled: z.boolean(),
});

const subscriptionRowSchema = subscriptionSchema.extend({
  updatedAt: z.string().datetime(),
});

interface NotificationsRoutesOptions {
  readonly repo: NotificationSubscriptionsRepository;
}

export async function notificationsRoutes(
  app: FastifyInstance,
  opts: NotificationsRoutesOptions
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAuth);

  route.get(
    "/",
    { schema: { response: { 200: z.array(subscriptionRowSchema) } } },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const rows = await opts.repo.listForUser(u.id);
      return rows.map((r) => ({
        type: r.type,
        channel: r.channel as "email" | "telegram",
        enabled: r.enabled,
        updatedAt: r.updatedAt.toISOString(),
      }));
    }
  );

  route.put(
    "/",
    {
      schema: {
        body: subscriptionSchema,
        response: { 200: subscriptionRowSchema },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const r = await opts.repo.upsert({
        userId: u.id,
        type: req.body.type,
        channel: req.body.channel,
        enabled: req.body.enabled,
      });
      return {
        type: r.type,
        channel: r.channel as "email" | "telegram",
        enabled: r.enabled,
        updatedAt: r.updatedAt.toISOString(),
      };
    }
  );
}
