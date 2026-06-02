import { z } from "zod";

import { api } from "@/lib/api/client";

export const anomalyFlagSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  walletId: z.string().nullable(),
  positionId: z.string().nullable(),
  chain: z.string().nullable(),
  protocolId: z.string().nullable(),
  marketKey: z.string().nullable(),
  checkId: z.string(),
  anomalyType: z.string().nullable(),
  severity: z.string(),
  phase: z.string(),
  observedValue: z.string().nullable(),
  expectedValue: z.string().nullable(),
  detail: z.record(z.unknown()).nullable(),
  goldenCaseId: z.string().nullable(),
  status: z.string(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
});
export type AnomalyFlag = z.infer<typeof anomalyFlagSchema>;

const flagsResponse = z.object({ flags: z.array(anomalyFlagSchema) });

const scanAccountResult = z.object({
  accountId: z.string(),
  skipped: z.boolean().optional(),
  positions: z.number().optional(),
  goldenCases: z.number().optional(),
  findings: z.number().optional(),
  resolved: z.number().optional(),
  bySeverity: z.record(z.number()).optional(),
});
const scanResponse = z.object({
  accounts: z.array(scanAccountResult),
  notFound: z.boolean().optional(),
});
export type ScanResponse = z.infer<typeof scanResponse>;

export const adminAnomalyApi = {
  list: (params: { accountId?: string; status?: string }) => {
    const q = new URLSearchParams();
    if (params.accountId) q.set("accountId", params.accountId);
    if (params.status) q.set("status", params.status);
    const qs = q.toString();
    return api.get(`/v1/admin/anomaly/flags${qs ? `?${qs}` : ""}`, flagsResponse);
  },
  scan: (account: string) =>
    api.post("/v1/admin/anomaly/scan", { account }, scanResponse),
};
