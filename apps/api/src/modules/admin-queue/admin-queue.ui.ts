import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { FastifyAdapter } from "@bull-board/fastify";
import type { FastifyInstance } from "fastify";

import type { PortfolioRefreshQueue } from "../queue/portfolio-refresh.queue.js";

export interface AdminQueueUiOptions {
  readonly queue: PortfolioRefreshQueue;
  /** Mount path relative to the API root (without trailing slash). */
  readonly basePath: string;
}

/**
 * Mount the bull-board dashboard under `basePath` (e.g. "/api/v1/admin/queue/ui")
 * and gate every request behind `requireAdmin`.
 *
 * Bull-board renders its own HTML/JS bundle and a sibling REST API for the
 * UI. Both are protected together: a non-admin trying to hit the dashboard
 * gets a 401/403, same as any other admin endpoint.
 */
export async function registerAdminQueueUi(
  app: FastifyInstance,
  opts: AdminQueueUiOptions
): Promise<void> {
  const serverAdapter = new FastifyAdapter().setBasePath(opts.basePath);

  createBullBoard({
    queues: [new BullMQAdapter(opts.queue.queue)],
    serverAdapter,
    options: {
      uiConfig: {
        boardTitle: "Capflow queues",
      },
    },
  });

  await app.register(
    async (scope) => {
      scope.addHook("preHandler", app.requireAdmin);
      await scope.register(serverAdapter.registerPlugin());
    },
    { prefix: opts.basePath }
  );
}
