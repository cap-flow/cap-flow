import { Queue } from "bullmq";
import type { Redis } from "ioredis";

export const ANOMALY_DETECT_QUEUE = "anomaly-detect";

export interface AnomalyDetectJobData {
  readonly trigger: "cron" | "manual";
}

export interface AnomalyDetectScheduleConfig {
  readonly everyMs: number;
}

/**
 * Epic C — recurring anomaly detector sweep. One global job (no per-account
 * sharding), concurrency 1 in the worker. Reads already-persisted
 * ucb_shadow_results + golden_cases (no external API), writes anomaly_flags.
 * Admin can force a re-scan via `enqueueManual`.
 */
export class AnomalyDetectQueue {
  readonly queue: Queue<AnomalyDetectJobData>;

  constructor(connection: Redis) {
    this.queue = new Queue<AnomalyDetectJobData>(ANOMALY_DETECT_QUEUE, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 50 },
      },
    });
  }

  async scheduleRecurring(cfg: AnomalyDetectScheduleConfig): Promise<void> {
    await this.queue.upsertJobScheduler(
      "anomaly-detect",
      { every: cfg.everyMs },
      { name: "scan", data: { trigger: "cron" } },
    );
  }

  async enqueueManual(): Promise<string> {
    const job = await this.queue.add(
      "scan",
      { trigger: "manual" },
      { jobId: `manual-${Math.floor(Date.now() / 1000)}` },
    );
    return job.id ?? "unknown";
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
