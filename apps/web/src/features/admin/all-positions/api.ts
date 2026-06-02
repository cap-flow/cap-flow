import { z } from "zod";

import { api } from "@/lib/api/client";

export const allPositionAnomalySchema = z.object({
  checkId: z.string(),
  severity: z.string(),
  reason: z.string(),
});

export const allPositionRowSchema = z.object({
  accountId: z.string(),
  ownerEmail: z.string().nullable(),
  accountName: z.string().nullable(),
  computedAt: z.string(),
  methodology: z.string(),
  positionId: z.string(),
  chain: z.string(),
  protocolId: z.string(),
  symbol: z.string(),
  matchedV3TokenId: z.string().nullable(),
  startUsd: z.number(),
  currentUsd: z.number(),
  netPnlUsd: z.number(),
  feesUsd: z.number().nullable(),
  coverageIncomplete: z.boolean(),
  anomalies: z.array(allPositionAnomalySchema),
});
export type AllPositionRow = z.infer<typeof allPositionRowSchema>;

const responseSchema = z.object({
  positions: z.array(allPositionRowSchema),
  accounts: z.number(),
  computedAt: z.string().nullable(),
});

export const adminAllPositionsApi = {
  list: () => api.get("/v1/admin/ucb/all-positions", responseSchema),
};
