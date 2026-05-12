import type { FastifyReply } from "fastify";

export const REFRESH_COOKIE_NAME = "cap_refresh";

/**
 * Access-token cookie name (S3.5).
 *
 * Issued on login/refresh, cleared on logout. Carries the same JWT as
 * the in-memory Bearer token, but lives in an HttpOnly cookie scoped
 * to `/api/v1/upstream` so:
 *   - The browser auto-attaches it on third-party API calls made via
 *     the upstream-proxy (DeBank/Helius/Etherscan/**Alchemy**). This
 *     is the only way viem's `http()` transport — which uses static
 *     `fetchOptions` — can authenticate against our proxy.
 *   - It is NOT sent to any non-upstream route, so XSS attack surface
 *     stays narrow.
 *   - It is unreadable to JS (HttpOnly), so XSS can't steal the JWT.
 *
 * `requireAuth` still prefers the `Authorization: Bearer` header when
 * present (frontend `apiFetch` keeps using it); the cookie is the
 * fallback for code paths that can't set custom headers.
 */
export const ACCESS_COOKIE_NAME = "cap_access";

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

export function setRefreshCookie(
  reply: FastifyReply,
  token: string,
  cfg: RefreshCookieConfig
): void {
  reply.setCookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: cfg.secure,
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
    // SameSite=lax: blocks cross-origin POST/PUT/DELETE (so an evil
    // site can't forge a state-changing upstream call) but allows
    // same-origin requests including viem's GET/POST.
    sameSite: "lax",
    path: "/api/v1/upstream",
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
    path: "/api/v1/upstream",
    ...(cfg.domain ? { domain: cfg.domain } : {}),
  });
}

/**
 * Resolves the inbound access token from either `Authorization: Bearer`
 * header (preferred) or the access cookie (fallback). Returns `null`
 * when neither is present. Pure function — testable without Fastify
 * boot.
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
