import { z } from "zod";

import { api } from "@/lib/api/client";

export const adminOperationRowSchema = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  accountName: z.string(),
  ownerId: z.string().uuid(),
  ownerEmail: z.string().nullable(),
  ownerName: z.string().nullable(),
  date: z.string(),
  type: z.string(),
  source: z.string(),
  fromName: z.string().nullable(),
  toName: z.string().nullable(),
  cur1: z.string().nullable(),
  amount1: z.string().nullable(),
  cur2: z.string().nullable(),
  amount2: z.string().nullable(),
  priceUsd: z.string().nullable(),
  network: z.string().nullable(),
  comment: z.string(),
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

const facetsSchema = z.object({ networks: z.array(z.string()) });
export type AdminOperationsFacets = z.infer<typeof facetsSchema>;

export interface AdminOperationsParams {
  readonly userId?: string;
  readonly accountId?: string;
  readonly type?: string;
  readonly network?: string;
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
