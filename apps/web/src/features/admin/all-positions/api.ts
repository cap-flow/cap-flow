import { z } from "zod";

import { api } from "@/lib/api/client";

export const allPositionAnomalySchema = z.object({
  checkId: z.string(),
  severity: z.string(),
  reason: z.string(),
});
export type AllPositionAnomaly = z.infer<typeof allPositionAnomalySchema>;

export const allPositionItemSchema = z.object({
  accountId: z.string(),
  ownerEmail: z.string().nullable(),
  accountName: z.string().nullable(),
  methodology: z.string(),
  computedAt: z.string(),
  /** Full OpenPosition object (rendered via the shared getColumnCell). */
  position: z.record(z.unknown()),
  anomalies: z.array(allPositionAnomalySchema),
  /** 'golden' = эталон (verified), 'wrong' = требует фикс, null = unmarked. */
  goldenKind: z.enum(["golden", "wrong"]).nullable().default(null),
});
export type AllPositionItem = z.infer<typeof allPositionItemSchema>;

const responseSchema = z.object({
  items: z.array(allPositionItemSchema),
  accounts: z.number(),
  computedAt: z.string().nullable(),
});

const computeAllSchema = z.object({
  total: z.number(),
  computed: z.number(),
  failed: z.number(),
  skipped: z.number(),
});
export type ComputeAllResult = z.infer<typeof computeAllSchema>;

export type ComputeMethodology = "auto" | "FIFO" | "LIFO" | "WAC" | "HIFO";

export const adminAllPositionsApi = {
  list: () => api.get("/v1/admin/ucb/all-positions", responseSchema),
  computeAll: (methodology: ComputeMethodology) =>
    api.post("/v1/admin/ucb/compute-all", { methodology }, computeAllSchema),
};
