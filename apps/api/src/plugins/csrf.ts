import { timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import { ForbiddenError } from "../core/errors.js";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from "../modules/auth/auth.cookies.js";

/**
 * Double-submit CSRF protection (2026-05-18).
 *
 * For every mutating HTTP method (POST/PUT/PATCH/DELETE) on the API
 * surface, the request must carry both:
 *   - A `cap_csrf` cookie (set on login/refresh/register-by-invite).
 *   - An `X-CSRF-Token` header with a value that matches the cookie
 *     in constant-time.
 *
 * Why this is sufficient:
 *   - Same-origin web frontend sets the header from a JS-readable
 *     cookie; an attacker site can't read our cookie cross-origin,
 *     so they can't reproduce the header.
 *   - The httpOnly access cookie (SameSite=Lax) plus the refresh
 *     cookie (SameSite=Strict, path-scoped to /api/v1/auth) close
 *     the auto-attach side channels.
 *
 * The protection is OPT-OUT via `req.routeOptions.config.skipCsrf` or
 * an explicit path allowlist below. The allowlist captures endpoints
 * that must work without a prior login (login / refresh / register
 * by invite / password-reset request).
 *
 * Safe methods (GET / HEAD / OPTIONS) are never checked — they
 * shouldn't carry side effects in a REST API.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Paths that establish a session (or are otherwise rate-limited and
 * stateless enough that CSRF would be theatre). Matched as prefixes.
 *
 * NOTE: the refresh path is here because the refresh cookie is
 * SameSite=Strict already — a cross-site forgery can't carry it.
 */
const PUBLIC_MUTATION_PATHS: readonly string[] = [
  "/api/v1/auth/login",
  "/api/v1/auth/refresh",
  "/api/v1/auth/password/request",
  "/api/v1/auth/password/reset",
  "/api/v1/auth/email-verification/send",
  "/api/v1/auth/email-verification/confirm",
  "/api/v1/invites/", // /:token/register and /:token preview
];

function isPublicPath(url: string): boolean {
  // Strip query string before prefix-matching.
  const qIdx = url.indexOf("?");
  const path = qIdx === -1 ? url : url.slice(0, qIdx);
  for (const prefix of PUBLIC_MUTATION_PATHS) {
    if (path === prefix || path.startsWith(prefix)) return true;
  }
  return false;
}

declare module "fastify" {
  interface FastifyContextConfig {
    /** Set on a route to bypass CSRF (e.g. webhook receivers). */
    skipCsrf?: boolean;
  }
}

/**
 * Constant-time equality. Bails out fast when lengths differ — that
 * leak is acceptable (CSRF tokens have a fixed length when issued by
 * our backend; a forged-length token is a malformed input, not a
 * cryptographic distinction).
 */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  if (a.length === 0) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return timingSafeEqual(bufA, bufB);
}

export const csrfPlugin = fp(
  async (app: FastifyInstance) => {
    app.addHook(
      "preHandler",
      async (req: FastifyRequest, _reply: FastifyReply) => {
        const method = req.method.toUpperCase();
        if (SAFE_METHODS.has(method)) return;

        // Route-level opt-out (webhooks, etc).
        const cfg = req.routeOptions?.config as
          | { skipCsrf?: boolean }
          | undefined;
        if (cfg?.skipCsrf) return;

        // Public mutation endpoints — login / refresh / invite-register
        // are session establishment, not session use; their own
        // rate-limit + credential checks are the defence.
        if (isPublicPath(req.url)) return;

        // Bull-board admin UI nests its own POSTs (job retry/remove)
        // under /api/v1/admin/queue/ui. It's behind requireAdmin auth
        // (mounted in app.ts via Fastify hook), authenticated through
        // the access cookie, and the UI sends its own internal CSRF
        // tokens; layering ours on top would break it. Same prefix
        // semantics as PUBLIC_MUTATION_PATHS.
        if (req.url.startsWith("/api/v1/admin/queue/ui")) return;

        const cookieToken = (req.cookies ?? {})[CSRF_COOKIE_NAME];
        const headerRaw = req.headers[CSRF_HEADER_NAME];
        const headerToken = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;

        if (!cookieToken || !headerToken) {
          throw new ForbiddenError("CSRF token missing.");
        }
        if (!constantTimeEquals(cookieToken, headerToken)) {
          throw new ForbiddenError("CSRF token mismatch.");
        }
      }
    );
  },
  { name: "csrf", dependencies: ["@fastify/cookie"] }
);
