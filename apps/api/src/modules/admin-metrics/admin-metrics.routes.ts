import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { AdminMetricsService } from "./admin-metrics.service.js";

const saasMetricsSchema = z.object({
  users: z.object({
    total: z.number(),
    active: z.number(),
    pending: z.number(),
    blocked: z.number(),
  }),
  dau: z.number(),
  wau: z.number(),
  mau: z.number(),
  newUsers: z.object({
    last24h: z.number(),
    last7d: z.number(),
    last30d: z.number(),
  }),
  invites: z.object({
    pending: z.number(),
    consumed: z.number(),
    revoked: z.number(),
    expired: z.number(),
  }),
  activation: z.object({
    within24hPct: z.number(),
    firstRefreshWithin7dPct: z.number(),
  }),
});

interface AdminMetricsRoutesOptions {
  readonly service: AdminMetricsService;
}

export async function adminMetricsRoutes(
  app: FastifyInstance,
  opts: AdminMetricsRoutesOptions
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAdmin);

  route.get(
    "/saas",
    { schema: { response: { 200: saasMetricsSchema } } },
    async () => opts.service.compute()
  );
}
