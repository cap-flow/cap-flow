import { z } from "zod";

import { api } from "@/lib/api/client";

/** Subset of OpenPosition the debug table renders (extras are stripped by zod). */
export const ucbPositionSchema = z.object({
  id: z.string().optional(),
  protocol: z.object({ id: z.string().optional(), name: z.string().optional() }).optional(),
  chain: z.string().optional(),
  supplyTokens: z.array(z.object({ symbol: z.string() })).optional(),
  matchedV3TokenId: z.string().nullable().optional(),
  startUsd: z.number().nullable().optional(),
  currentUsd: z.number().nullable().optional(),
  netPnlUsd: z.number().nullable().optional(),
  netPnlPct: z.number().nullable().optional(),
  feesUsd: z.number().nullable().optional(),
  feeApr: z.number().nullable().optional(),
  coverageIncomplete: z.boolean().optional(),
  openedAt: z.number().nullable().optional(),
});
export type UcbPosition = z.infer<typeof ucbPositionSchema>;

export const ucbGoldenOverlaySchema = z.object({
  label: z.string(),
  expectedStartUsd: z.number(),
  drift: z.boolean(),
});

export const ucbFindingSchema = z.object({
  checkId: z.string(),
  severity: z.string(),
  positionId: z.string().nullable(),
  observedValue: z.number().nullable(),
  expectedValue: z.number().nullable(),
  reason: z.string(),
});
export type UcbFinding = z.infer<typeof ucbFindingSchema>;

export const ucbAccountResultSchema = z.object({
  accountId: z.string(),
  label: z.string(),
  positionCount: z.number(),
  positions: z.array(ucbPositionSchema),
  golden: z.record(ucbGoldenOverlaySchema).optional(),
  findings: z.array(ucbFindingSchema).optional(),
  error: z.string().optional(),
});
export type UcbAccountResult = z.infer<typeof ucbAccountResultSchema>;

export const ucbComputeResponseSchema = z.object({
  methodology: z.string(),
  accounts: z.array(ucbAccountResultSchema),
  notFound: z.boolean().optional(),
});
export type UcbComputeResponse = z.infer<typeof ucbComputeResponseSchema>;

export type Methodology = "FIFO" | "LIFO" | "WAC" | "HIFO";

export const adminUcbApi = {
  compute: (account: string, methodology: Methodology) =>
    api.post(
      "/v1/admin/ucb/compute",
      { account, methodology },
      ucbComputeResponseSchema,
    ),
};
