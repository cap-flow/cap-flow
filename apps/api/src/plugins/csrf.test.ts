/**
 * CSRF double-submit guard tests (2026-05-18).
 *
 * Boots a minimal Fastify instance with only the cookie parser + the
 * csrf plugin, then registers a couple of toy routes. We're verifying:
 *
 *   - safe methods (GET/HEAD/OPTIONS) skip the check
 *   - mutating methods require BOTH cookie + header
 *   - mismatched cookie/header → 403
 *   - matching cookie/header → 200
 *   - public mutation paths (login/refresh/...) bypass
 *   - per-route `skipCsrf: true` opt-out works
 *
 * The full app uses the same plugin (registered in app.ts) and the
 * same allowlist; this isolated test covers regressions in the policy.
 */
import cookiePlugin from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from "../modules/auth/auth.cookies.js";

import { csrfPlugin } from "./csrf.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

async function build(): Promise<FastifyInstance> {
  const f = Fastify();
  await f.register(cookiePlugin, { secret: "x".repeat(32) });
  await f.register(csrfPlugin);

  f.get("/api/v1/safe", async () => ({ ok: true }));
  f.post("/api/v1/protected", async () => ({ ok: true }));
  f.post("/api/v1/auth/login", async () => ({ ok: true }));
  f.post("/api/v1/auth/refresh", async () => ({ ok: true }));
  f.post("/api/v1/invites/abc123/register", async () => ({ ok: true }));
  f.post(
    "/api/v1/webhook",
    { config: { skipCsrf: true } },
    async () => ({ ok: true })
  );
  return f;
}

const TOKEN = "csrf-token-value-1234567890abcdef";

describe("csrf plugin", () => {
  it("safe methods pass without any CSRF artefacts", async () => {
    app = await build();
    const r = await app.inject({ method: "GET", url: "/api/v1/safe" });
    expect(r.statusCode).toBe(200);
  });

  it("mutating method without CSRF cookie → 403", async () => {
    app = await build();
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/protected",
      headers: { [CSRF_HEADER_NAME]: TOKEN },
    });
    expect(r.statusCode).toBe(403);
  });

  it("mutating method without CSRF header → 403", async () => {
    app = await build();
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/protected",
      cookies: { [CSRF_COOKIE_NAME]: TOKEN },
    });
    expect(r.statusCode).toBe(403);
  });

  it("mutating method with mismatched cookie/header → 403", async () => {
    app = await build();
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/protected",
      cookies: { [CSRF_COOKIE_NAME]: TOKEN },
      headers: { [CSRF_HEADER_NAME]: TOKEN + "x" },
    });
    expect(r.statusCode).toBe(403);
  });

  it("mutating method with matching cookie+header → 200", async () => {
    app = await build();
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/protected",
      cookies: { [CSRF_COOKIE_NAME]: TOKEN },
      headers: { [CSRF_HEADER_NAME]: TOKEN },
    });
    expect(r.statusCode).toBe(200);
  });

  it("/auth/login is public — POST without CSRF still 200", async () => {
    app = await build();
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
    });
    expect(r.statusCode).toBe(200);
  });

  it("/auth/refresh is public — POST without CSRF still 200", async () => {
    app = await build();
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
    });
    expect(r.statusCode).toBe(200);
  });

  it("/invites/:token/register is public — POST without CSRF still 200", async () => {
    app = await build();
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/invites/abc123/register",
    });
    expect(r.statusCode).toBe(200);
  });

  it("route-level skipCsrf:true bypasses the guard", async () => {
    app = await build();
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/webhook",
    });
    expect(r.statusCode).toBe(200);
  });

  it("length-difference between cookie and header still rejects", async () => {
    // Constant-time check bails out on length mismatch without leaking
    // which one was wrong; we just verify it still 403's.
    app = await build();
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/protected",
      cookies: { [CSRF_COOKIE_NAME]: TOKEN },
      headers: { [CSRF_HEADER_NAME]: TOKEN.slice(0, -1) },
    });
    expect(r.statusCode).toBe(403);
  });
});
