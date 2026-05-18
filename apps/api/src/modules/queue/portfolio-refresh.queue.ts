import { Queue } from "bullmq";
import type { Redis } from "ioredis";

export const PORTFOLIO_REFRESH_QUEUE = "portfolio-refresh";

export interface PortfolioRefreshJobData {
  readonly accountId: string;
  /** Who triggered: cron / admin (manual) / user (manual). */
  readonly trigger: "cron" | "admin" | "user";
  /** Optional actor — for audit-log lineage. */
  readonly actorUserId?: string;
}

export interface ScheduleConfig {
  /** Refresh cadence in milliseconds. Default 1h. */
  readonly everyMs: number;
  /** Per-account jitter window (ms) so 25 accounts don't all fire at :00. */
  readonly jitterMs: number;
}

/**
 * Wrapper around BullMQ Queue for portfolio refresh jobs.
 *
 * Two flavours of jobs share the queue:
 *   - **recurring** — one per active account, managed via the v5
 *     JobScheduler API (`upsertJobScheduler`). Scheduler id is
 *     `account-<uuid>` so re-running scheduleRecurring is idempotent.
 *   - **manual** — one-shot, `jobId` is `manual-<uuid>-<unix-seconds>` to
 *     dedup double-click while still distinct from recurring fires.
 *
 * Note: BullMQ jobIds cannot contain `:`, so we use `-` throughout.
 */
export class PortfolioRefreshQueue {
  readonly queue: Queue<PortfolioRefreshJobData>;

  constructor(connection: Redis) {
    this.queue = new Queue<PortfolioRefreshJobData>(PORTFOLIO_REFRESH_QUEUE, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        // Keep last 100 done + 100 failed jobs for the admin dashboard;
        // the rest is auto-pruned so Redis memory stays bounded.
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 100 },
      },
    });
  }

  /** Manual one-off refresh. Returns the job id. */
  async enqueueManual(
    accountId: string,
    actorUserId: string,
    trigger: "admin" | "user"
  ): Promise<string> {
    // M6 (2026-05-14): widen the dedup window from 1s to 30s. Every
    // refresh consumes ~5 DeBank credits + queues a worker job; the
    // pre-fix 1-second bucket was too tight to catch impatient
    // double-/triple-clicks (slow first refresh → user mashes button
    // → 5+ refreshes queued in 3 seconds). 30s suppresses noise while
    // still allowing a deliberate re-trigger half-a-minute later.
    const bucket = Math.floor(Date.now() / 30_000);
    const job = await this.queue.add(
      "refresh",
      { accountId, trigger, actorUserId },
      { jobId: `manual-${accountId}-${bucket}` }
    );
    return job.id ?? "unknown";
  }

  /**
   * Idempotently schedule a recurring refresh for one account.
   *
   * Uses BullMQ 5's JobScheduler API — the deterministic scheduler id
   * collapses duplicates and lets us remove cleanly on archive.
   */
  async scheduleRecurring(
    accountId: string,
    cfg: ScheduleConfig
  ): Promise<void> {
    const jitter = stableJitter(accountId, cfg.jitterMs);
    // `startDate` offsets the first firing by `jitter` ms — every account
    // lands in its own minute-slot of the hour. The recurrence then repeats
    // every `everyMs` from there.
    await this.queue.upsertJobScheduler(
      `account-${accountId}`,
      { every: cfg.everyMs, startDate: Date.now() + jitter },
      {
        name: "refresh",
        data: { accountId, trigger: "cron" },
      }
    );
  }

  async removeRecurring(accountId: string): Promise<void> {
    await this.queue.removeJobScheduler(`account-${accountId}`);
  }

  /** Get most recent N jobs for status display. */
  async recentForAccount(accountId: string, limit: number) {
    const states = [
      "completed",
      "failed",
      "active",
      "waiting",
      "delayed",
    ] as const;
    const all = await this.queue.getJobs([...states], 0, 200);
    return all
      .filter((j) => j.data.accountId === accountId)
      .sort(
        (a, b) =>
          (b.timestamp ?? 0) - (a.timestamp ?? 0) ||
          (b.finishedOn ?? 0) - (a.finishedOn ?? 0)
      )
      .slice(0, limit);
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

/**
 * Deterministic per-account jitter — same account always lands in the same
 * slot of its hour. Stops 25 accounts from all firing at :00:00.
 */
function stableJitter(accountId: string, windowMs: number): number {
  let h = 0;
  for (let i = 0; i < accountId.length; i++) {
    h = (h * 31 + accountId.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % windowMs;
}
