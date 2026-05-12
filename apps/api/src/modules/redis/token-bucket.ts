import type { Redis } from "ioredis";

/**
 * Daily token-bucket quota keyed by (subject, provider).
 *
 * We use a per-UTC-day counter + EXPIRE rather than a sliding-window bucket
 * because:
 *   - upstream providers themselves bill on calendar-day boundaries,
 *   - the math is one INCR + one EXPIRE — cheap at scale,
 *   - reset semantics are obvious to a human admin reading the dashboard.
 *
 * A fancier sliding-window per-minute bucket can be layered on top later if
 * burst protection becomes a real issue.
 */
export interface QuotaCheckResult {
  readonly allowed: boolean;
  readonly used: number;
  readonly limit: number;
  readonly resetAtUtc: Date;
}

export class TokenBucket {
  constructor(private readonly redis: Redis) {}

  /** Attempt to consume one token. Returns whether allowed + counters. */
  async consume(
    subjectId: string,
    provider: string,
    dailyLimit: number
  ): Promise<QuotaCheckResult> {
    const { key, resetAt, secondsToReset } = dayKey(subjectId, provider);
    // INCR; if first hit of the day, set EXPIRE.
    const used = await this.redis.incr(key);
    if (used === 1) {
      await this.redis.expire(key, secondsToReset);
    }
    const allowed = used <= dailyLimit;
    return { allowed, used, limit: dailyLimit, resetAtUtc: resetAt };
  }

  /** Peek without consuming — for admin dashboard. */
  async peek(
    subjectId: string,
    provider: string,
    dailyLimit: number
  ): Promise<QuotaCheckResult> {
    const { key, resetAt } = dayKey(subjectId, provider);
    const raw = await this.redis.get(key);
    const used = raw ? Number(raw) : 0;
    return {
      allowed: used < dailyLimit,
      used,
      limit: dailyLimit,
      resetAtUtc: resetAt,
    };
  }

  /** Reset the counter (admin override). */
  async reset(subjectId: string, provider: string): Promise<void> {
    const { key } = dayKey(subjectId, provider);
    await this.redis.del(key);
  }
}

function dayKey(
  subjectId: string,
  provider: string
): { key: string; resetAt: Date; secondsToReset: number } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const day = `${y}${m}${d}`;
  const key = `quota:${provider}:${subjectId}:${day}`;
  const resetAt = new Date(Date.UTC(y, now.getUTCMonth(), now.getUTCDate() + 1));
  const secondsToReset = Math.ceil((resetAt.getTime() - now.getTime()) / 1000);
  return { key, resetAt, secondsToReset };
}
