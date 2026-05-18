import { z } from "zod";

import { api } from "@/lib/api/client";

const sectionStatus = z.enum(["ok", "warn", "error"]);

export const healthStatusSchema = z.object({
  ok: z.boolean(),
  overallStatus: sectionStatus,
  generatedAt: z.string().datetime(),
  uptimeSec: z.number(),
  nodeVersion: z.string(),
  db: z.object({
    status: sectionStatus,
    poolTotal: z.number().nullable(),
    poolIdle: z.number().nullable(),
    poolWaiting: z.number().nullable(),
    pingMs: z.number().nullable(),
    error: z.string().nullable(),
  }),
  redis: z.object({
    status: sectionStatus,
    pingMs: z.number().nullable(),
    error: z.string().nullable(),
  }),
  queue: z.object({
    status: sectionStatus,
    counts: z.object({
      active: z.number(),
      waiting: z.number(),
      delayed: z.number(),
      completed: z.number(),
      failed: z.number(),
    }),
    error: z.string().nullable(),
  }),
  wallets: z.object({
    status: sectionStatus,
    total: z.number(),
    withErrors: z.number(),
    oldestSyncIso: z.string().nullable(),
  }),
  cexAccounts: z.object({
    status: sectionStatus,
    total: z.number(),
    withErrors: z.number(),
  }),
});

export type HealthStatus = z.infer<typeof healthStatusSchema>;
export type SectionStatus = z.infer<typeof sectionStatus>;

export const adminHealthApi = {
  status: () => api.get("/v1/admin/health", healthStatusSchema),
};
