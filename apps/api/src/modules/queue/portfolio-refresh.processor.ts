import type { Job } from "bullmq";

import type { PortfolioRefreshService } from "../portfolio/portfolio-refresh.service.js";

import type { PortfolioRefreshJobData } from "./portfolio-refresh.queue.js";

/**
 * BullMQ job processor for `portfolio-refresh`.
 *
 * Thin wrapper around `PortfolioRefreshService`: BullMQ owns retries +
 * backoff (configured on the queue); processor only translates a job into
 * a single domain call and lets exceptions bubble so BullMQ marks failure.
 */
export class PortfolioRefreshProcessor {
  constructor(private readonly service: PortfolioRefreshService) {}

  async process(job: Job<PortfolioRefreshJobData>): Promise<unknown> {
    const data = job.data;
    // The queue's trigger union is "cron" | "admin" | "user"; the service
    // collapses the two manual flavours into a single audit action.
    const trigger: "cron" | "manual" = data.trigger === "cron" ? "cron" : "manual";
    return this.service.refreshAccount({
      accountId: data.accountId,
      trigger,
      actorUserId: data.actorUserId ?? null,
    });
  }
}
