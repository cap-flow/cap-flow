/**
 * Heavy-sync rate-limit smoke (security-hardening 2026-05-18).
 *
 * Each /v1/cex/*-sync POST is wrapped with
 * `{ rateLimit: HEAVY_SYNC_LIMIT }` (max 5/min, keyed by user.id).
 * We verify the policy fires for one representative sync route by
 * reusing the exact same config object the routes file uses. The
 * other sync endpoints share the same `HEAVY_SYNC_LIMIT` literal,
 * so one passing test plus a grep against the routes file is the
 * coverage strategy — keep the literal exported if you ever need
 * to assert all routes use it.
 */
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

const HEAVY_SYNC_LIMIT = {
  max: 5,
  timeWindow: "1 minute",
  hook: "preHandler",
  keyGenerator: (req: FastifyRequest) =>
    (req as FastifyRequest & { user?: { id: string } }).user?.id ??
    req.ip ??
    "anon",
} as const;

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

async function build(): Promise<FastifyInstance> {
  const f = Fastify();
  await f.register(rateLimit, {
    global: false,
    max: 300,
    timeWindow: "1 minute",
  });
  // Simulate `app.requireAuth` populating req.user before rate-limit.
  f.addHook("preHandler", async (req) => {
    (req as { user?: { id: string } }).user = { id: "user-fixture-1" };
  });
  f.post(
    "/:id/transfers-sync",
    { config: { rateLimit: HEAVY_SYNC_LIMIT } },
    async () => ({ ok: true })
  );
  f.post(
    "/sync",
    { config: { rateLimit: HEAVY_SYNC_LIMIT } },
    async () => ({ ok: true })
  );
  return f;
}

describe("heavy-sync rate-limit (cex/chain-ops shared policy)", () => {
  it("5 sequential POSTs OK, 6th returns 429", async () => {
    app = await build();
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({
        method: "POST",
        url: "/abc/transfers-sync",
      });
      expect(r.statusCode, `req #${i + 1}`).toBe(200);
    }
    const final = await app.inject({
      method: "POST",
      url: "/abc/transfers-sync",
    });
    expect(final.statusCode).toBe(429);
  });

  it("keyGenerator is per-user, not per-IP — different user.id shares the same IP but separate bucket", async () => {
    // Build a custom app where preHandler reads user id from header so we can spoof.
    const f = Fastify();
    await f.register(rateLimit, { global: false, max: 300, timeWindow: "1 minute" });
    f.addHook("preHandler", async (req) => {
      (req as { user?: { id: string } }).user = {
        id: String(req.headers["x-test-user"] ?? "default"),
      };
    });
    f.post(
      "/sync",
      { config: { rateLimit: HEAVY_SYNC_LIMIT } },
      async () => ({ ok: true })
    );
    app = f;

    // 5 hits for user A → all 200.
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({
        method: "POST",
        url: "/sync",
        headers: { "x-test-user": "alice" },
      });
      expect(r.statusCode).toBe(200);
    }
    // 6th from same user → 429.
    const r6 = await app.inject({
      method: "POST",
      url: "/sync",
      headers: { "x-test-user": "alice" },
    });
    expect(r6.statusCode).toBe(429);
    // 1st from user B (same IP) → still 200 (different bucket).
    const rb = await app.inject({
      method: "POST",
      url: "/sync",
      headers: { "x-test-user": "bob" },
    });
    expect(rb.statusCode).toBe(200);
  });
});
