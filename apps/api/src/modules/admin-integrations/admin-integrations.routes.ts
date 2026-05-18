import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { UnauthorizedError, ValidationError } from "../../core/errors.js";
import type { AuditService } from "../audit/audit.service.js";
import { testProxy } from "../cex/cex.proxy-tester.js";

import type { AdminIntegrationsService } from "./admin-integrations.service.js";

const integrationStatusSchema = z.object({
  key: z.string(),
  name: z.string(),
  purpose: z.string(),
  envVar: z.string(),
  configured: z.boolean(),
  hasDbOverride: z.boolean(),
  valuePreview: z.string().nullable(),
  editedAt: z.string().nullable(),
  perUserQuotaPerDay: z.number().nullable(),
  usageProvider: z.string().nullable(),
  calls24h: z.number(),
  errors24h: z.number(),
  cacheHits24h: z.number(),
  totalCostUsd24h: z.number(),
  lastCallAt: z.string().nullable(),
  lastError: z.string().nullable(),
});

interface AdminIntegrationsRoutesOptions {
  readonly service: AdminIntegrationsService;
  readonly audit: AuditService;
  /**
   * Hooks fired after a key is set or cleared. Used by the CEX proxy
   * state to invalidate its cached agent without waiting for a TTL or
   * a process restart. Keys that don't match any hook → no-op.
   */
  readonly onKeyChanged?: Partial<Record<string, () => Promise<void>>>;
}

export async function adminIntegrationsRoutes(
  app: FastifyInstance,
  opts: AdminIntegrationsRoutesOptions
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAdmin);

  route.get(
    "/",
    { schema: { response: { 200: z.array(integrationStatusSchema) } } },
    async () => opts.service.listAll()
  );

  /**
   * Upsert DB-override for an integration secret.
   * Body: `{ value: string }` — empty string clears the override (revert to env).
   * Audit-logged. Never echo back the value.
   */
  route.patch(
    "/:key",
    {
      schema: {
        params: z.object({ key: z.string().min(1).max(64) }),
        body: z.object({ value: z.string().max(2000) }),
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      await opts.service.setSecret(req.params.key, req.body.value, u.id);
      await opts.audit.log({
        actorUserId: u.id,
        action: "integration.secret_updated",
        payload: {
          key: req.params.key,
          // Never log the value — only that it was set (true) or cleared (false).
          cleared: req.body.value.trim().length === 0,
        },
      });
      const hook = opts.onKeyChanged?.[req.params.key];
      if (hook) await hook();
      return { ok: true as const };
    }
  );

  /**
   * UCB B1: тест candidate proxy URL без сохранения в БД. Probes 3
   * CEX endpoint'а параллельно и возвращает diagnostic. URL никогда
   * не пишется в audit_log в plain виде — credentials маскируются.
   */
  route.post(
    "/cex_proxy/test",
    {
      schema: {
        body: z.object({
          value: z.string().min(8).max(2000),
        }),
        response: {
          200: z.object({
            proxyUrl: z.string(),
            anyOk: z.boolean(),
            results: z.array(
              z.object({
                exchange: z.string(),
                url: z.string(),
                status: z.enum([
                  "ok",
                  "geo_blocked",
                  "auth_failed",
                  "timeout",
                  "network_error",
                  "exchange_error",
                ]),
                latencyMs: z.number(),
                httpCode: z.number().nullable(),
                note: z.string().nullable(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      try {
        const report = await testProxy(req.body.value);
        await opts.audit.log({
          actorUserId: u.id,
          action: "integration.proxy_tested",
          payload: {
            proxyUrl: report.proxyUrl, // already masked
            anyOk: report.anyOk,
            results: report.results.map((r) => ({
              exchange: r.exchange,
              status: r.status,
              latencyMs: r.latencyMs,
              httpCode: r.httpCode,
            })),
          },
        });
        // Spread readonly → mutable для Fastify-Zod handler return-type.
        return {
          proxyUrl: report.proxyUrl,
          anyOk: report.anyOk,
          results: report.results.map((r) => ({ ...r })),
        };
      } catch (e) {
        throw new ValidationError((e as Error).message);
      }
    },
  );

  /** Clear DB override → fall back to env. */
  route.delete(
    "/:key",
    {
      schema: {
        params: z.object({ key: z.string().min(1).max(64) }),
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      await opts.service.clearSecret(req.params.key, u.id);
      await opts.audit.log({
        actorUserId: u.id,
        action: "integration.secret_cleared",
        payload: { key: req.params.key },
      });
      const hook = opts.onKeyChanged?.[req.params.key];
      if (hook) await hook();
      return { ok: true as const };
    }
  );
}
