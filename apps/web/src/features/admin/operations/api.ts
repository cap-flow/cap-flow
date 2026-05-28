import { z } from "zod";

import { api } from "@/lib/api/client";

export const adminOperationMovementSchema = z.object({
  symbol: z.string(),
  amount: z.number(),
  usd: z.number().nullable(),
  direction: z.enum(["in", "out"]),
});
export type AdminOperationMovement = z.infer<
  typeof adminOperationMovementSchema
>;

export const adminOperationRowSchema = z.object({
  id: z.string().uuid(),
  walletId: z.string().uuid(),
  walletName: z.string(),
  accountId: z.string().uuid(),
  accountName: z.string(),
  ownerId: z.string().uuid(),
  ownerEmail: z.string().nullable(),
  ownerName: z.string().nullable(),
  opTime: z.string().datetime(),
  opType: z.string(),
  chain: z.string(),
  status: z.string(),
  txHash: z.string(),
  protocol: z.string().nullable(),
  counterparty: z.string().nullable(),
  netUsd: z.number().nullable(),
  gasUsd: z.number().nullable(),
  movements: z.array(adminOperationMovementSchema),
  notes: z.array(z.string()),
  createdAt: z.string().datetime(),
});
export type AdminOperationRow = z.infer<typeof adminOperationRowSchema>;

export const adminOperationsPageSchema = z.object({
  items: z.array(adminOperationRowSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});
export type AdminOperationsPage = z.infer<typeof adminOperationsPageSchema>;

const facetsSchema = z.object({
  chains: z.array(z.string()),
  opTypes: z.array(z.string()),
});
export type AdminOperationsFacets = z.infer<typeof facetsSchema>;

export interface AdminOperationsParams {
  readonly userId?: string;
  readonly accountId?: string;
  readonly walletId?: string;
  readonly type?: string;
  readonly chain?: string;
  readonly status?: string;
  readonly from?: string;
  readonly to?: string;
  readonly search?: string;
  readonly limit?: number;
  readonly offset?: number;
}

function toQuery(params: AdminOperationsParams): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export const adminOperationsApi = {
  list: (params: AdminOperationsParams) =>
    api.get(
      `/v1/admin/operations${toQuery(params)}`,
      adminOperationsPageSchema
    ),
  facets: () => api.get("/v1/admin/operations/facets", facetsSchema),
};
