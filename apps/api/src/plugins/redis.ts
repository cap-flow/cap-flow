import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { Redis } from "ioredis";

declare module "fastify" {
  interface FastifyInstance {
    redis: Redis;
  }
}

export interface RedisPluginOptions {
  readonly url: string;
}

/**
 * Single shared ioredis client decorated as `app.redis`.
 *
 * Used by three subsystems:
 *   - cache (price / balance / token-meta) — see `modules/redis/cache.ts`
 *   - per-user quotas — see `modules/redis/token-bucket.ts`
 *   - BullMQ queue (Phase 4 — will use a second connection)
 *
 * The connection is lazy + auto-reconnects; we log but don't crash on
 * transient errors. Persistent failures will surface via the health endpoint
 * once Phase 4 wires it in.
 */
export const redisPlugin = fp<RedisPluginOptions>(
  async (app: FastifyInstance, opts) => {
    const client = new Redis(opts.url, {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });

    client.on("error", (err: Error) => {
      app.log.error({ err }, "redis error");
    });
    client.on("connect", () => {
      app.log.info("redis connected");
    });

    app.decorate("redis", client);
    app.addHook("onClose", async () => {
      await client.quit();
    });
  },
  { name: "redis" }
);
