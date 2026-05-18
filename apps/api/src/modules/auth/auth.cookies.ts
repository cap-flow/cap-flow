import { randomBytes } from "node:crypto";

import type { FastifyReply } from "fastify";

export const REFRESH_COOKIE_NAME = "cap_refresh";

/**
 * Access-token cookie (S3.5 → broadened in S6 — 2026-05-18).
 *
 * Holds the JWT access token. Marked HttpOnly + SameSite=Lax so:
 *   - JS cannot read it (XSS-resistant).
 *   - Browsers send it automatically on same-origin requests, including
 *     viem's HTTP transport (which can't set custom headers).
 *   - SameSite=Lax blocks cross-site POST/PUT/DELETE forgeries while
 *     still allowing top-level navigations.
 *
 * Path was previously `/api/v1/upstream` (only viem-driven upstream
 * proxy calls needed it). After the migration off `localStorage` /
 * Bearer header, every API call relies on the cookie — so it now lives
 * at `/` (cookie path can't be set to `/api/v1` reliably in dev because
 * Vite's `/api` proxy strips the prefix and the browser would still see
 * the API responses, but the cookie wouldn't echo back; root path is
 * the only portable scope).
 *
 * `requireAuth` still ACCEPTS `Authorization: Bearer` as a fallback so
 * existing test fixtures and any code path that hasn't migrated yet
 * keeps working — the Bearer fallback is the deprecation path and will
 * be removed in a follow-up commit (2026-06-XX target).
 */
export const ACCESS_COOKIE_NAME = "cap_access";

/**
 * CSRF double-submit token cookie (2026-05-18).
 *
 * Issued alongside auth cookies on login/refresh/register-by-invite.
 * The token is also returned in the JSON body and exposed in
 * `document.cookie` (NOT HttpOnly), so the frontend can read it and
 * echo it back as the `X-CSRF-Token` request header on every
 * state-changing request (POST/PUT/PATCH/DELETE).
 *
 * Why double-submit instead of `@fastify/csrf-protection`?
 *   - Zero extra plugin / Fastify version pinning.
 *   - The frontend already runs on the same origin as the API
 *     (Vite proxy in dev, single-domain in prod), so a *value*
 *     comparison (cookie value === header value) is sufficient:
 *     an attacker can't read the cookie cross-origin (SameSite=Lax
 *     + httpOnly access cookie blocks the side-channel paths), and
 *     can't set our cookie cross-origin either.
 *   - Stateless — no token store in Redis to keep in sync with
 *     sessions.
 *
 * Cookie flags:
 *   - httpOnly: FALSE (frontend must read it to echo back).
 *   - secure  : production only.
 *   - sameSite: lax.
 *   - path    : "/" (frontend never knows which mutating route comes
 *               next).
 */
export const CSRF_COOKIE_NAME = "cap_csrf";

/**
 * Header the frontend must echo the CSRF token back in.
 *
 * Constant-time-compared against the cookie value on every mutating
 * request that isn't on the public-skip allowlist (login / refresh /
 * register-by-invite / password-reset request).
 */
export const CSRF_HEADER_NAME = "x-csrf-token";

export interface RefreshCookieConfig {
  readonly secure: boolean;
  readonly domain?: string | undefined;
  readonly maxAgeSeconds: number;
}

export interface AccessCookieConfig {
  readonly secure: boolean;
  readonly domain?: string | undefined;
  readonly maxAgeSeconds: number;
}

export interface CsrfCookieConfig {
  readonly secure: boolean;
  readonly domain?: string | undefined;
  readonly maxAgeSeconds: number;
}

export function setRefreshCookie(
  reply: FastifyReply,
  token: string,
  cfg: RefreshCookieConfig
): void {
  reply.setCookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: cfg.secure,
    // Strict so a cross-site request can never trigger a refresh-rotation
    // off a stolen Lax-mode browser. The /refresh endpoint itself is a
    // top-level POST initiated by our own code; SameSite=Strict still
    // attaches the cookie for same-origin POST.
    sameSite: "strict",
    path: "/api/v1/auth",
    maxAge: cfg.maxAgeSeconds,
    ...(cfg.domain ? { domain: cfg.domain } : {}),
  });
}

export function clearRefreshCookie(
  reply: FastifyReply,
  cfg: Pick<RefreshCookieConfig, "secure" | "domain">
): void {
  reply.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: cfg.secure,
    sameSite: "strict",
    path: "/api/v1/auth",
    ...(cfg.domain ? { domain: cfg.domain } : {}),
  });
}

export function setAccessCookie(
  reply: FastifyReply,
  token: string,
  cfg: AccessCookieConfig
): void {
  reply.setCookie(ACCESS_COOKIE_NAME, token, {
    httpOnly: true,
    secure: cfg.secure,
    // SameSite=Lax: blocks cross-origin POST/PUT/DELETE (so an evil
    // site can't forge a state-changing call) but allows same-origin
    // requests, including viem's GET/POST.
    sameSite: "lax",
    path: "/",
    maxAge: cfg.maxAgeSeconds,
    ...(cfg.domain ? { domain: cfg.domain } : {}),
  });
}

export function clearAccessCookie(
  reply: FastifyReply,
  cfg: Pick<AccessCookieConfig, "secure" | "domain">
): void {
  reply.clearCookie(ACCESS_COOKIE_NAME, {
    httpOnly: true,
    secure: cfg.secure,
    sameSite: "lax",
    path: "/",
    ...(cfg.domain ? { domain: cfg.domain } : {}),
  });
}

/**
 * Mint a fresh CSRF token. 32-byte cryptographic random → hex.
 * One per login / refresh / register; rotated on each issue.
 */
export function generateCsrfToken(): string {
  return randomBytes(32).toString("hex");
}

export function setCsrfCookie(
  reply: FastifyReply,
  token: string,
  cfg: CsrfCookieConfig
): void {
  reply.setCookie(CSRF_COOKIE_NAME, token, {
    // Readable by JS so frontend can echo into the X-CSRF-Token header.
    httpOnly: false,
    secure: cfg.secure,
    sameSite: "lax",
    path: "/",
    maxAge: cfg.maxAgeSeconds,
    ...(cfg.domain ? { domain: cfg.domain } : {}),
  });
}

export function clearCsrfCookie(
  reply: FastifyReply,
  cfg: Pick<CsrfCookieConfig, "secure" | "domain">
): void {
  reply.clearCookie(CSRF_COOKIE_NAME, {
    httpOnly: false,
    secure: cfg.secure,
    sameSite: "lax",
    path: "/",
    ...(cfg.domain ? { domain: cfg.domain } : {}),
  });
}

/**
 * Resolves the inbound access token from either `Authorization: Bearer`
 * header (preferred — legacy path, deprecation TODO 2026-06-XX) or the
 * access cookie (the new default). Returns `null` when neither is
 * present. Pure function — testable without Fastify boot.
 */
export function extractAccessToken(req: {
  headers: { authorization?: string | undefined };
  cookies: Record<string, string | undefined>;
}): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    const t = header.slice("Bearer ".length).trim();
    if (t) return t;
  }
  const c = req.cookies[ACCESS_COOKIE_NAME];
  if (c && c.length > 0) return c;
  return null;
}
