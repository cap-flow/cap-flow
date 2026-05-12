import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { PortfolioRefreshQueue } from "../queue/portfolio-refresh.queue.js";

const queueStatusSchema = z.object({
  name: z.string(),
  counts: z.object({
    active: z.number(),
    waiting: z.number(),
    delayed: z.number(),
    completed: z.number(),
    failed: z.number(),
  }),
  recurringSchedules: z.array(
    z.object({
      key: z.string(),
      name: z.string().nullable(),
      every: z.number().nullable(),
      next: z.number().nullable(),
    })
  ),
});

interface AdminQueueRoutesOptions {
  readonly queue: PortfolioRefreshQueue;
}

/**
 * JSON status endpoint for the admin "queue" tab. The full bull-board UI is
 * mounted separately via `registerAdminQueueUi`; this is what the SaaS
 * dashboard fetches to render its compact "Queue health" panel.
 */
export async function adminQueueRoutes(
  app: FastifyInstance,
  opts: AdminQueueRoutesOptions
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAdmin);

  route.get(
    "/status",
    { schema: { response: { 200: queueStatusSchema } } },
    async () => {
      const counts = await opts.queue.queue.getJobCounts(
        "active",
        "waiting",
        "delayed",
        "completed",
        "failed"
      );
      const schedulers = await opts.queue.queue.getJobSchedulers();
      return {
        name: opts.queue.queue.name,
        counts: {
          active: counts["active"] ?? 0,
          waiting: counts["waiting"] ?? 0,
          delayed: counts["delayed"] ?? 0,
          completed: counts["completed"] ?? 0,
          failed: counts["failed"] ?? 0,
        },
        recurringSchedules: schedulers.map((s) => ({
          key: s.key,
          name: s.name ?? null,
          every: s.every !== undefined ? Number(s.every) : null,
          next: s.next ?? null,
        })),
      };
    }
  );
}
