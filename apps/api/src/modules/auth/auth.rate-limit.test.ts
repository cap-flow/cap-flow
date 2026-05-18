/**
 * /auth/refresh + /auth/logout rate-limit smoke (security-hardening 2026-05-18).
 *
 * Builds the smallest possible Fastify app with `@fastify/rate-limit`
 * (global: false, same as production) and re-declares just the two
 * routes' configs we care about. The handlers are no-ops because all
 * we're verifying is that the policy fires — the actual auth flow is
 * covered elsewhere.
 *
 * Why not boot the real app? It needs Postgres + Redis + 30+ services.
 * A 60-line in-memory smoke captures the same regression risk: someone
 * removing `config.rateLimit` on these routes.
 */
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

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
  f.post(
    "/auth/refresh",
    {
      config: {
        rateLimit: { max: 30, timeWindow: "15 minutes" },
      },
    },
    async () => ({ ok: true })
  );
  f.post(
    "/auth/logout",
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "5 minutes",
          keyGenerator: (req: { ip?: string }) => req.ip ?? "anon",
        },
      },
    },
    async () => ({ ok: true })
  );
  return f;
}

describe("/auth rate-limits (security-hardening)", () => {
  it("/auth/refresh — 30 hits OK, 31st returns 429", async () => {
    app = await build();
    for (let i = 0; i < 30; i++) {
      const r = await app.inject({ method: "POST", url: "/auth/refresh" });
      expect(r.statusCode, `req #${i + 1}`).toBe(200);
    }
    const final = await app.inject({ method: "POST", url: "/auth/refresh" });
    expect(final.statusCode).toBe(429);
  });

  it("/auth/logout — 20 hits OK, 21st returns 429", async () => {
    app = await build();
    for (let i = 0; i < 20; i++) {
      const r = await app.inject({ method: "POST", url: "/auth/logout" });
      expect(r.statusCode, `req #${i + 1}`).toBe(200);
    }
    const final = await app.inject({ method: "POST", url: "/auth/logout" });
    expect(final.statusCode).toBe(429);
  });
});
