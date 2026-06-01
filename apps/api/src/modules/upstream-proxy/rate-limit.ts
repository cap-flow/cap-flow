/**
 * Per-user rate-limit for upstream-proxy (S2).
 *
 * Fixed-window dual-bucket: per-minute + per-hour caps. Each request
 * increments both buckets atomically (one Redis pipeline) and checks
 * both counters against their limits. If either exceeds → 429 with a
 * `Retry-After` seconds hint.
 *
 * Why fixed-window over sliding:
 *   - Two INCR+EXPIRE ops per request, no sorted-set scan.
 *   - At the edge of a window the worst-case burst is `2 × perMinute`
 *     (last second of bucket N + first of N+1). For our use case
 *     (guarding admin API quotas measured over hours), that's fine.
 *
 * Storage is abstracted behind `RateLimitStore` so tests can use
 * `InMemoryRateLimitStore` and prod can use `RedisRateLimitStore`.
 */

import type { Redis } from "ioredis";

export interface RateLimitStore {
  /**
   * Increment the counter at `key` (creating it at 1 if absent) and set
   * its TTL to `ttlSeconds`. Atomic — multiple concurrent callers can't
   * cause the count to drift below `1`.
   *
   * Returns the new count.
   */
  incrAndExpire(key: string, ttlSeconds: number): Promise<number>;
}

/* ------------------------- in-memory (tests) ------------------------------ */

interface Cell {
  count: number;
  /** ms timestamp when the cell expires. */
  expiresAt: number;
}

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly cells = new Map<string, Cell>();
  constructor(private readonly clock: () => number = () => Date.now()) {}

  async incrAndExpire(key: string, ttlSeconds: number): Promise<number> {
    const now = this.clock();
    const cell = this.cells.get(key);
    if (!cell || cell.expiresAt <= now) {
      this.cells.set(key, { count: 1, expiresAt: now + ttlSeconds * 1000 });
      return 1;
    }
    cell.count += 1;
    return cell.count;
  }
}

/* ------------------------- redis (prod) ----------------------------------- */

export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: Redis) {}

  async incrAndExpire(key: string, ttlSeconds: number): Promise<number> {
    const pipeline = this.redis.pipeline();
    pipeline.incr(key);
    pipeline.expire(key, ttlSeconds);
    const results = await pipeline.exec();
    // results[0] = [err, count], results[1] = [err, 1|0]
    const first = results?.[0];
    if (!first || first[0]) {
      throw first?.[0] ?? new Error("redis incrAndExpire failed");
    }
    return Number(first[1]);
  }
}

/* ------------------------- service ---------------------------------------- */

export interface RateLimitConfig {
  /**
   * Per-minute cap. Может быть числом ИЛИ геттером — геттер позволяет читать
   * live-значение из admin-настроек (`AppSettingsService`) на каждом запросе,
   * так что админ меняет лимит без рестарта API.
   */
  readonly perMinute: number | (() => number);
  /** Per-hour cap. Число или live-геттер (см. perMinute). */
  readonly perHour: number | (() => number);
  /** Override for testing. Defaults to `Date.now`. */
  readonly clock?: () => number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remainingMinute: number;
  readonly remainingHour: number;
  readonly retryAfterSeconds: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export class UpstreamRateLimitService {
  private readonly clock: () => number;
  constructor(
    private readonly store: RateLimitStore,
    private readonly cfg: RateLimitConfig
  ) {
    this.clock = cfg.clock ?? (() => Date.now());
  }

  /** Резолвим число-или-геттер в актуальное значение лимита. */
  private resolve(v: number | (() => number)): number {
    return typeof v === "function" ? v() : v;
  }

  async check(userId: string): Promise<RateLimitDecision> {
    const now = this.clock();
    const minBucket = Math.floor(now / MINUTE_MS);
    const hourBucket = Math.floor(now / HOUR_MS);
    const minKey = `rl:up:m:${userId}:${minBucket}`;
    const hourKey = `rl:up:h:${userId}:${hourBucket}`;

    // TTL slightly longer than the bucket so the key survives clock skew.
    const minCount = await this.store.incrAndExpire(minKey, 65);
    const hourCount = await this.store.incrAndExpire(hourKey, 3605);

    const perMinute = this.resolve(this.cfg.perMinute);
    const perHour = this.resolve(this.cfg.perHour);
    const minOk = minCount <= perMinute;
    const hourOk = hourCount <= perHour;
    const allowed = minOk && hourOk;

    const remainingMinute = Math.max(0, perMinute - minCount);
    const remainingHour = Math.max(0, perHour - hourCount);

    let retryAfterSeconds = 0;
    if (!allowed) {
      if (!hourOk) {
        const expiresAt = (hourBucket + 1) * HOUR_MS;
        retryAfterSeconds = Math.ceil((expiresAt - now) / 1000);
      } else {
        const expiresAt = (minBucket + 1) * MINUTE_MS;
        retryAfterSeconds = Math.ceil((expiresAt - now) / 1000);
      }
    }

    return { allowed, remainingMinute, remainingHour, retryAfterSeconds };
  }
}
