/**
 * Cookie-flag invariants for the auth migration (2026-05-18).
 *
 * Boots a tiny Fastify app, hits routes that mirror the production
 * cookie helpers, and asserts the Set-Cookie attributes a real client
 * would see. We do this at the integration level (not unit) because
 * the only behaviour that matters is what hits the wire after
 * `@fastify/cookie` formats the response — getting `httpOnly` /
 * `SameSite` / `Path` right at the helper call site means nothing if a
 * Fastify upgrade silently drops them.
 */
import cookiePlugin from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  ACCESS_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  clearAccessCookie,
  clearCsrfCookie,
  clearRefreshCookie,
  generateCsrfToken,
  setAccessCookie,
  setCsrfCookie,
  setRefreshCookie,
} from "./auth.cookies.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

async function build(secure: boolean): Promise<FastifyInstance> {
  const f = Fastify();
  await f.register(cookiePlugin, { secret: "x".repeat(32) });
  const cfg = { secure, maxAgeSeconds: 3600 };
  f.post("/login", async (_req, reply) => {
    setAccessCookie(reply, "access-jwt", cfg);
    setRefreshCookie(reply, "refresh-token", { ...cfg, maxAgeSeconds: 86400 });
    setCsrfCookie(reply, generateCsrfToken(), { ...cfg, maxAgeSeconds: 86400 });
    return reply.status(204).send();
  });
  f.post("/logout", async (_req, reply) => {
    clearAccessCookie(reply, cfg);
    clearRefreshCookie(reply, cfg);
    clearCsrfCookie(reply, cfg);
    return reply.status(204).send();
  });
  return f;
}

function getSetCookieValues(headers: Record<string, unknown>): string[] {
  const raw = headers["set-cookie"];
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === "string") return [raw];
  return [];
}

function findCookie(cookies: string[], name: string): string {
  const hit = cookies.find((c) => c.startsWith(`${name}=`));
  if (!hit) throw new Error(`Set-Cookie missing for ${name}`);
  return hit;
}

describe("auth cookie flags", () => {
  it("login (production) sets access cookie HttpOnly + Secure + Lax + path=/", async () => {
    app = await build(true);
    const r = await app.inject({ method: "POST", url: "/login" });
    expect(r.statusCode).toBe(204);
    const setCookie = getSetCookieValues(r.headers);
    const access = findCookie(setCookie, ACCESS_COOKIE_NAME);
    expect(access).toMatch(/HttpOnly/i);
    expect(access).toMatch(/Secure/i);
    expect(access).toMatch(/SameSite=Lax/i);
    expect(access).toMatch(/Path=\//);
    // Sanity: the value is set.
    expect(access).toMatch(/^cap_access=access-jwt/);
  });

  it("login (production) sets refresh cookie HttpOnly + Secure + Strict + path=/api/v1/auth", async () => {
    app = await build(true);
    const r = await app.inject({ method: "POST", url: "/login" });
    const setCookie = getSetCookieValues(r.headers);
    const refresh = findCookie(setCookie, REFRESH_COOKIE_NAME);
    expect(refresh).toMatch(/HttpOnly/i);
    expect(refresh).toMatch(/Secure/i);
    expect(refresh).toMatch(/SameSite=Strict/i);
    expect(refresh).toMatch(/Path=\/api\/v1\/auth/);
  });

  it("login (production) sets CSRF cookie NOT HttpOnly + Secure + Lax + path=/", async () => {
    app = await build(true);
    const r = await app.inject({ method: "POST", url: "/login" });
    const setCookie = getSetCookieValues(r.headers);
    const csrf = findCookie(setCookie, CSRF_COOKIE_NAME);
    expect(csrf).not.toMatch(/HttpOnly/i);
    expect(csrf).toMatch(/Secure/i);
    expect(csrf).toMatch(/SameSite=Lax/i);
    expect(csrf).toMatch(/Path=\//);
  });

  it("login (development) omits Secure but keeps HttpOnly on access cookie", async () => {
    // On localhost (HTTP), Secure cookies would be dropped by the
    // browser. The COOKIE_SECURE env knob lets us turn it off in dev.
    app = await build(false);
    const r = await app.inject({ method: "POST", url: "/login" });
    const setCookie = getSetCookieValues(r.headers);
    const access = findCookie(setCookie, ACCESS_COOKIE_NAME);
    expect(access).not.toMatch(/Secure/i);
    expect(access).toMatch(/HttpOnly/i);
  });

  it("logout clears all three cookies (Expires in the past / Max-Age=0)", async () => {
    app = await build(true);
    const r = await app.inject({ method: "POST", url: "/logout" });
    const setCookie = getSetCookieValues(r.headers);
    const names = setCookie.map((c) => c.split("=", 1)[0]);
    expect(names).toContain(ACCESS_COOKIE_NAME);
    expect(names).toContain(REFRESH_COOKIE_NAME);
    expect(names).toContain(CSRF_COOKIE_NAME);
    // `clearCookie` emits Expires or Max-Age=0; check at least one.
    for (const name of [ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME, CSRF_COOKIE_NAME]) {
      const c = findCookie(setCookie, name);
      expect(c).toMatch(/Expires=|Max-Age=0/i);
    }
  });
});

describe("generateCsrfToken", () => {
  it("returns a 64-char hex string", () => {
    const t = generateCsrfToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns distinct tokens on each call", () => {
    const a = generateCsrfToken();
    const b = generateCsrfToken();
    expect(a).not.toBe(b);
  });
});
