import { z } from "zod";

import { api } from "@/lib/api/client";

export const integrationStatusSchema = z.object({
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
export type IntegrationStatus = z.infer<typeof integrationStatusSchema>;

const integrationsListSchema = z.array(integrationStatusSchema);
const okSchema = z.object({ ok: z.literal(true) });

/** UCB B1: проверка candidate CEX-proxy без сохранения. */
export const proxyTestStatusSchema = z.enum([
  "ok",
  "geo_blocked",
  "auth_failed",
  "timeout",
  "network_error",
  "exchange_error",
]);
export type ProxyTestStatus = z.infer<typeof proxyTestStatusSchema>;

export const proxyTestReportSchema = z.object({
  proxyUrl: z.string(),
  anyOk: z.boolean(),
  results: z.array(
    z.object({
      exchange: z.string(),
      url: z.string(),
      status: proxyTestStatusSchema,
      latencyMs: z.number(),
      httpCode: z.number().nullable(),
      note: z.string().nullable(),
    }),
  ),
});
export type ProxyTestReport = z.infer<typeof proxyTestReportSchema>;

export const adminIntegrationsApi = {
  list: () => api.get("/v1/admin/integrations", integrationsListSchema),
  setSecret: (key: string, value: string) =>
    api.patch(`/v1/admin/integrations/${key}`, { value }, okSchema),
  clearSecret: (key: string) =>
    api.delete(`/v1/admin/integrations/${key}`, okSchema),
  /** Probe candidate CEX-proxy URL без сохранения. */
  testCexProxy: (value: string) =>
    api.post(
      "/v1/admin/integrations/cex_proxy/test",
      { value },
      proxyTestReportSchema,
    ),
};
