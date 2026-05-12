import { Queue } from "bullmq";
import type { Redis } from "ioredis";

export const PAYMENT_MONITOR_QUEUE = "payment-monitor";

export interface PaymentMonitorJobData {
  readonly trigger: "cron" | "manual";
}

export interface PaymentMonitorScheduleConfig {
  readonly everyMs: number;
}

/**
 * Recurring scan that polls blockchain providers for new USDT transfers and
 * credits subscriptions when they cross both confirmation and price
 * thresholds. Lives in the worker process — API just enqueues by HTTP if
 * an admin wants to force a re-scan.
 */
export class PaymentMonitorQueue {
  readonly queue: Queue<PaymentMonitorJobData>;

  constructor(connection: Redis) {
    this.queue = new Queue<PaymentMonitorJobData>(PAYMENT_MONITOR_QUEUE, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 50 },
      },
    });
  }

  async scheduleRecurring(cfg: PaymentMonitorScheduleConfig): Promise<void> {
    await this.queue.upsertJobScheduler(
      "payment-monitor",
      { every: cfg.everyMs },
      { name: "scan", data: { trigger: "cron" } }
    );
  }

  async enqueueManual(): Promise<string> {
    const job = await this.queue.add(
      "scan",
      { trigger: "manual" },
      { jobId: `manual-${Math.floor(Date.now() / 1000)}` }
    );
    return job.id ?? "unknown";
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
