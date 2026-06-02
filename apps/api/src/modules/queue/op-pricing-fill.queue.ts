import { Queue } from "bullmq";
import type { Redis } from "ioredis";

export const OP_PRICING_FILL_QUEUE = "op-pricing-fill";

export interface OpPricingFillJobData {
  readonly trigger: "cron" | "manual";
}

export interface OpPricingFillScheduleConfig {
  readonly everyMs: number;
}

/**
 * UCB B1 — recurring sweep that warms the shared `op_token_prices` cache for
 * every active account (deterministic block-fixed prices). One global job (no
 * per-account sharding), runs in the worker process at concurrency 1 to avoid
 * hammering DefiLlama. Admin can force a re-fill via `enqueueManual`. Cache-fill
 * only — serves nothing, gates nothing.
 */
export class OpPricingFillQueue {
  readonly queue: Queue<OpPricingFillJobData>;

  constructor(connection: Redis) {
    this.queue = new Queue<OpPricingFillJobData>(OP_PRICING_FILL_QUEUE, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 50 },
      },
    });
  }

  async scheduleRecurring(cfg: OpPricingFillScheduleConfig): Promise<void> {
    await this.queue.upsertJobScheduler(
      "op-pricing-fill",
      { every: cfg.everyMs },
      { name: "fill", data: { trigger: "cron" } },
    );
  }

  async enqueueManual(): Promise<string> {
    const job = await this.queue.add(
      "fill",
      { trigger: "manual" },
      { jobId: `manual-${Math.floor(Date.now() / 1000)}` },
    );
    return job.id ?? "unknown";
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
