import { z } from "zod";

import { api } from "@/lib/api/client";

export const saasMetricsSchema = z.object({
  users: z.object({
    total: z.number(),
    active: z.number(),
    pending: z.number(),
    blocked: z.number(),
  }),
  dau: z.number(),
  wau: z.number(),
  mau: z.number(),
  newUsers: z.object({
    last24h: z.number(),
    last7d: z.number(),
    last30d: z.number(),
  }),
  invites: z.object({
    pending: z.number(),
    consumed: z.number(),
    revoked: z.number(),
    expired: z.number(),
  }),
  activation: z.object({
    within24hPct: z.number(),
    firstRefreshWithin7dPct: z.number(),
  }),
});
export type SaasMetrics = z.infer<typeof saasMetricsSchema>;

export const adminMetricsApi = {
  saas: () => api.get("/v1/admin/metrics/saas", saasMetricsSchema),
};
