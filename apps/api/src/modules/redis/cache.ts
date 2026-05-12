import type { Redis } from "ioredis";

/**
 * Tiny JSON cache wrapper on top of ioredis.
 *
 * Keys live in flat namespaces (`price:USDC`, `balance:1:0xabc…`); TTL is set
 * per-write. We never trust cached payloads to validate via Zod — caller
 * decides the shape because schemas live next to call sites.
 */
export class JsonCache {
  constructor(private readonly redis: Redis) {}

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Bad payload → treat as cache miss.
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  /**
   * Memoize an async producer with TTL. If multiple callers race for a cold
   * key, the first one wins; the others either get the fresh write or
   * compute again — acceptable for read-mostly upstream calls.
   */
  async wrap<T>(
    key: string,
    ttlSeconds: number,
    producer: () => Promise<T>
  ): Promise<{ value: T; cached: boolean }> {
    const cached = await this.get<T>(key);
    if (cached !== null) return { value: cached, cached: true };
    const value = await producer();
    await this.set(key, value, ttlSeconds);
    return { value, cached: false };
  }
}
