/**
 * Upstream-proxy Fastify routes (S1c).
 *
 * Surface: `* /v1/upstream/:provider/*` (auth-required). Calls land in
 * `UpstreamProxyService.forward`, which injects the admin API key, then
 * the upstream response is mirrored back to the caller verbatim.
 *
 * Rate-limiting + per-user audit logging will land in S2 as a wrapper
 * around this route. For now, every request is recorded in the existing
 * `api_usage` table so admin can already see who hit what.
 */

import type { FastifyInstance } from "fastify";

import { UnauthorizedError } from "../../core/errors.js";
import type { ApiUsageRepository } from "../api-usage/api-usage.repository.js";
import type { WalletsRepository } from "../wallets/wallets.repository.js";

import {
  buildOwnedSet,
  decide,
  type OwnedAddressSet,
  type ProxyRequestForGuard,
} from "./address-guard.js";
import type { UpstreamRateLimitService } from "./rate-limit.js";
import {
  UpstreamProxyError,
  type ProxyRequest,
  type UpstreamProxyService,
} from "./upstream-proxy.service.js";

interface UpstreamProxyRoutesOptions {
  readonly service: UpstreamProxyService;
  readonly apiUsage: ApiUsageRepository;
  readonly rateLimit: UpstreamRateLimitService;
  /** IDOR guard: confirms forwarded addresses belong to caller. */
  readonly wallets: WalletsRepository;
}

const SUPPORTED_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"] as const;
type SupportedMethod = (typeof SUPPORTED_METHODS)[number];

export async function upstreamProxyRoutes(
  app: FastifyInstance,
  opts: UpstreamProxyRoutesOptions
): Promise<void> {
  const route = app;
  route.addHook("preHandler", app.requireAuth);

  route.route({
    method: [...SUPPORTED_METHODS],
    url: "/:provider/*",
    handler: async (req, reply) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();

      const params = req.params as { provider: string; "*": string };
      const provider = params.provider;
      const upstreamPath = params["*"] ?? "";
      const method = req.method.toUpperCase() as SupportedMethod;

      // Per-user rate-limit — protects admin's upstream API quotas
      // (DeBank Pro, Helius paid, Alchemy paid). Fixed-window dual-bucket
      // (per-minute + per-hour). On reject → 429 + Retry-After header.
      const decision = await opts.rateLimit.check(u.id);
      if (!decision.allowed) {
        reply
          .code(429)
          .header("Retry-After", String(decision.retryAfterSeconds))
          .header("X-RateLimit-Remaining-Minute", String(decision.remainingMinute))
          .header("X-RateLimit-Remaining-Hour", String(decision.remainingHour));
        // Still log the throttle event so admin can spot abuse patterns.
        void opts.apiUsage
          .insert({
            userId: u.id,
            accountId: null,
            provider: `upstream:${provider}`,
            endpoint: `${method} ${upstreamPath.slice(0, 200)}`,
            httpStatus: 429,
            durationMs: 0,
            cacheHit: 0,
            error: "rate_limited",
          })
          .catch(() => undefined);
        return reply.send({
          error: "rate_limited",
          retryAfterSeconds: decision.retryAfterSeconds,
        });
      }

      // Fastify gives us `req.query` as Record<string, unknown>; normalize.
      const query: Record<string, string | string[] | undefined> = {};
      if (req.query && typeof req.query === "object") {
        for (const [k, v] of Object.entries(req.query as Record<string, unknown>)) {
          if (v === undefined || v === null) continue;
          if (Array.isArray(v)) query[k] = v.map(String);
          else query[k] = String(v);
        }
      }

      const proxyReq: ProxyRequest = {
        provider,
        method,
        path: upstreamPath,
        query,
        ...(req.body !== undefined && req.body !== null
          ? { body: req.body }
          : {}),
      };

      // IDOR guard — every blockchain address forwarded upstream must
      // belong to the caller (or caller must be admin). Without this
      // any authenticated user can scan any wallet at our quota's
      // expense.
      const guardReq: ProxyRequestForGuard = {
        provider,
        method,
        path: upstreamPath,
        query,
        body: req.body,
      };
      // In-request memoize: a chained walker may call us multiple
      // times in one HTTP request, but we don't want to keep hitting
      // the DB. Stash the lazy on `req` itself.
      const reqAny = req as unknown as {
        __ownedSet?: Promise<OwnedAddressSet>;
      };
      if (!reqAny.__ownedSet) {
        reqAny.__ownedSet = opts.wallets
          .listAddressesByOwner(u.id)
          .then((rows) => buildOwnedSet(rows));
      }
      const ownedSet = await reqAny.__ownedSet;
      const guard = decide(guardReq, ownedSet, {
        isAdmin: u.role === "admin",
      });
      if (guard.kind !== "allow") {
        const status = guard.kind === "malformed" ? 400 : 403;
        // Audit the rejection so admin can see scraping attempts.
        void opts.apiUsage
          .insert({
            userId: u.id,
            accountId: null,
            provider: `upstream:${provider}`,
            endpoint: `${method} ${upstreamPath.slice(0, 200)}`,
            httpStatus: status,
            durationMs: 0,
            cacheHit: 0,
            error: guard.kind,
          })
          .catch(() => undefined);
        return reply
          .code(status)
          .send({ error: guard.kind, message: guard.message });
      }

      const t0 = Date.now();
      let httpStatus = 0;
      let errorMsg: string | undefined;
      let retries = 0;
      try {
        const r = await opts.service.forward(proxyReq);
        httpStatus = r.status;
        retries = r.retries ?? 0;
        reply.code(r.status);
        if (r.contentType) reply.header("Content-Type", r.contentType);
        return reply.send(r.body);
      } catch (err) {
        if (err instanceof UpstreamProxyError) {
          const statusMap: Record<typeof err.kind, number> = {
            unknown_provider: 404,
            missing_api_key: 503,
            forbidden_path: 403,
            network: 502,
            internal: 500,
          };
          httpStatus = statusMap[err.kind];
          errorMsg = `${err.kind}: ${err.message}`;
          return reply
            .code(httpStatus)
            .send({ error: err.kind, message: err.message });
        }
        httpStatus = 500;
        errorMsg = err instanceof Error ? err.message.slice(0, 500) : String(err);
        throw err;
      } finally {
        // Per-user audit/observability. Don't wait — fire & forget.
        // If api_usage write fails we still served the user.
        // Encode retry count into the endpoint string so we can grep
        // `(r=N)` to find which calls had to back off — useful when
        // diagnosing rate-limit pressure on a provider.
        const endpoint =
          retries > 0
            ? `${method} ${upstreamPath.slice(0, 180)} (r=${retries})`
            : `${method} ${upstreamPath.slice(0, 200)}`;
        void opts.apiUsage
          .insert({
            userId: u.id,
            accountId: null,
            provider: `upstream:${provider}`,
            endpoint,
            httpStatus,
            durationMs: Date.now() - t0,
            cacheHit: 0,
            ...(errorMsg ? { error: errorMsg.slice(0, 500) } : {}),
          })
          .catch(() => {
            /* observability failure must not break user request */
          });
      }
    },
  });
}
