/**
 * Admin-only client for the golden-cases / anomaly API (Epic A3, plan Q6).
 * Mirrors the server contract in `apps/api/src/modules/golden/golden.routes.ts`.
 */
import { z } from "zod";

import { api } from "@/lib/api/client";

export const goldenCaseSchema = z.object({
  id: z.string(),
  walletId: z.string(),
  positionId: z.string(),
  chain: z.string(),
  protocolId: z.string(),
  marketKey: z.string().nullable(),
  openHash: z.string().nullable(),
  label: z.string(),
  positionKey: z.string().nullable(),
  kind: z.string(),
  issue: z.string().nullable(),
  expectedStartUsd: z.number().nullable(),
  expectedNetStartUsd: z.number().nullable(),
  expectedPnlUsd: z.number().nullable(),
  toleranceAbsUsd: z.number().nullable(),
  tolerancePct: z.number().nullable(),
  sourceOfTruth: z.string(),
  provenanceNote: z.string().nullable(),
  methodologyVersion: z.string(),
  fixturePath: z.string().nullable(),
  status: z.string(),
  derivation: z.any().nullable(),
  createdByUserId: z.string().nullable(),
  promotedFromAnomalyId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type GoldenCase = z.infer<typeof goldenCaseSchema>;

const listSchema = z.object({ cases: z.array(goldenCaseSchema) });

export interface CreateGoldenBody {
  walletId: string;
  positionId: string;
  chain: string;
  protocolId: string;
  marketKey: string | null;
  openHash: string | null;
  label: string;
  positionKey: string | null;
  kind: "golden" | "wrong";
  issue: string | null;
  derivation?: unknown;
  expectedStartUsd: number | null;
  expectedNetStartUsd: number | null;
  expectedPnlUsd: number | null;
  toleranceAbsUsd: number;
  tolerancePct: number;
  sourceOfTruth: string;
  provenanceNote: string | null;
  methodologyVersion: string;
  fixturePath: string | null;
}

export const adminGoldenApi = {
  create: (body: CreateGoldenBody) =>
    api.post("/v1/admin/golden/cases", body, goldenCaseSchema),
  list: (walletId?: string) =>
    api.get(
      `/v1/admin/golden/cases${walletId ? `?walletId=${walletId}` : ""}`,
      listSchema,
    ),
};
