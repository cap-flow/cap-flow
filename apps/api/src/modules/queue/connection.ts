import { Redis, type RedisOptions } from "ioredis";

/**
 * BullMQ requires its ioredis connection to have specific options
 * (`maxRetriesPerRequest: null`, `enableReadyCheck: false`) — different from
 * the app's general-purpose Redis client. We provision a separate connection
 * here so neither subsystem's behavior leaks into the other.
 */
export function createBullConnection(redisUrl: string): Redis {
  const opts: RedisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
  return new Redis(redisUrl, opts);
}
