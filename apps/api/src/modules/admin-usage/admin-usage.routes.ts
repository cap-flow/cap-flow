import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { Env } from "../../config/env.js";
import { UnauthorizedError } from "../../core/errors.js";
import type { IApiUsageRepository } from "../api-usage/api-usage.repository.js";
import type { AppSettingsService } from "../app-settings/app-settings.service.js";
import type { TokenBucket } from "../redis/token-bucket.js";

const summaryQuerySchema = z.object({
  /** Look-back window in hours. Default 24h. Max 30 days. */
  hours: z.coerce.number().int().positive().max(24 * 30).default(24),
});

const summaryResponseSchema = z.object({
  since: z.string().datetime(),
  perProvider: z.array(
    z.object({
      provider: z.string(),
      calls: z.number(),
      errors: z.number(),
      cacheHits: z.number(),
      totalCostUsd: z.string(),
    })
  ),
  topUsers: z.array(
    z.object({ userId: z.string().uuid(), calls: z.number() })
  ),
});

const recentResponseSchema = z.array(
  z.object({
    id: z.string().uuid(),
    userId: z.string().uuid().nullable(),
    accountId: z.string().uuid().nullable(),
    provider: z.string(),
    endpoint: z.string(),
    httpStatus: z.number().nullable(),
    durationMs: z.number().nullable(),
    cacheHit: z.number(),
    costEstimateUsd: z.string().nullable(),
    error: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
);

const quotaQuerySchema = z.object({
  userId: z.string().uuid(),
});

const quotaResponseSchema = z.object({
  userId: z.string().uuid(),
  perProvider: z.array(
    z.object({
      provider: z.string(),
      used: z.number(),
      limit: z.number(),
      resetAt: z.string().datetime(),
    })
  ),
});

interface AdminUsageRoutesOptions {
  readonly repo: IApiUsageRepository;
  readonly bucket: TokenBucket;
  readonly env: Env;
  /**
   * Опционально: live-квоты из app-settings (админ-настройки). Если передан —
   * лимиты читаются отсюда (с override), иначе fallback на env-дефолты.
   */
  readonly appSettings?: AppSettingsService;
}

export async function adminUsageRoutes(
  app: FastifyInstance,
  opts: AdminUsageRoutesOptions
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAdmin);

  route.get(
    "/summary",
    {
      schema: {
        querystring: summaryQuerySchema,
        response: { 200: summaryResponseSchema },
      },
    },
    async (req) => {
      const since = new Date(Date.now() - req.query.hours * 60 * 60 * 1000);
      const [perProvider, topUsers] = await Promise.all([
        opts.repo.summaryByProvider(since),
        opts.repo.topUsers(since, 10),
      ]);
      return {
        since: since.toISOString(),
        perProvider,
        topUsers,
      };
    }
  );

  route.get(
    "/recent",
    {
      schema: {
        querystring: z.object({
          limit: z.coerce.number().int().positive().max(500).default(100),
        }),
        response: { 200: recentResponseSchema },
      },
    },
    async (req) => {
      const rows = await opts.repo.recent(req.query.limit);
      return rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        accountId: r.accountId,
        provider: r.provider,
        endpoint: r.endpoint,
        httpStatus: r.httpStatus,
        durationMs: r.durationMs,
        cacheHit: r.cacheHit,
        costEstimateUsd: r.costEstimateUsd,
        error: r.error,
        createdAt: r.createdAt.toISOString(),
      }));
    }
  );

  route.get(
    "/quotas",
    {
      schema: {
        querystring: quotaQuerySchema,
        response: { 200: quotaResponseSchema },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      // Live-квоты из app-settings (если сервис передан), иначе env-дефолты.
      const s = opts.appSettings;
      const quota = async (settingKey: string, envVal: number): Promise<number> =>
        s ? s.getNumber(settingKey) : envVal;
      const providers: Array<{ name: string; limit: number }> = [
        {
          name: "coingecko",
          limit: await quota("quota.coingeckoPerDay", opts.env.QUOTA_COINGECKO_PER_DAY),
        },
        {
          name: "debank",
          limit: await quota("quota.debankPerDay", opts.env.QUOTA_DEBANK_PER_DAY),
        },
        {
          name: "alchemy",
          limit: await quota("quota.alchemyPerDay", opts.env.QUOTA_ALCHEMY_PER_DAY),
        },
        {
          name: "etherscan",
          limit: await quota("quota.etherscanPerDay", opts.env.QUOTA_ETHERSCAN_PER_DAY),
        },
      ];
      const rows = await Promise.all(
        providers.map(async (p) => {
          const peek = await opts.bucket.peek(
            req.query.userId,
            p.name,
            p.limit
          );
          return {
            provider: p.name,
            used: peek.used,
            limit: peek.limit,
            resetAt: peek.resetAtUtc.toISOString(),
          };
        })
      );
      return { userId: req.query.userId, perProvider: rows };
    }
  );
}
