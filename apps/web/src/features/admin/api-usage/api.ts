import { z } from "zod";

import { api } from "@/lib/api/client";

export const summaryResponseSchema = z.object({
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
export type ApiUsageSummary = z.infer<typeof summaryResponseSchema>;

export const recentResponseSchema = z.array(
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
export type ApiUsageRecent = z.infer<typeof recentResponseSchema>;

export const quotaResponseSchema = z.object({
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
export type ApiUsageQuotas = z.infer<typeof quotaResponseSchema>;

export const adminApiUsageApi = {
  summary: (hours: number) =>
    api.get(`/v1/admin/api-usage/summary?hours=${hours}`, summaryResponseSchema),
  recent: (limit: number) =>
    api.get(`/v1/admin/api-usage/recent?limit=${limit}`, recentResponseSchema),
  quotas: (userId: string) =>
    api.get(
      `/v1/admin/api-usage/quotas?userId=${encodeURIComponent(userId)}`,
      quotaResponseSchema
    ),
};
