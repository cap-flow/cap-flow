import { z } from "zod";

import { api } from "@/lib/api/client";

export const adminAccountRowSchema = z.object({
  accountId: z.string().uuid(),
  accountName: z.string(),
  ownerId: z.string().uuid(),
  ownerEmail: z.string().nullable(),
  ownerName: z.string().nullable(),
  isPrimary: z.boolean(),
  lastSnapshotAt: z.string().datetime().nullable(),
  lastSnapshotUsd: z.number().nullable(),
  lastTrigger: z.string().nullable(),
  snapshotCount24h: z.number(),
  errors24h: z.number(),
});
export type AdminAccountRow = z.infer<typeof adminAccountRowSchema>;

export const adminAggregateSchema = z.object({
  accountsActive: z.number(),
  usersActive: z.number(),
  totalUsd: z.number(),
  snapshotsLast24h: z.number(),
  errorsLast24h: z.number(),
});
export type AdminAggregate = z.infer<typeof adminAggregateSchema>;

const adminAccountsListSchema = z.array(adminAccountRowSchema);

const refreshAllResponseSchema = z.object({
  enqueued: z.number(),
  accountIds: z.array(z.string().uuid()),
});
export type AdminRefreshAllResponse = z.infer<typeof refreshAllResponseSchema>;

export const adminPortfoliosApi = {
  list: () => api.get("/v1/admin/portfolios", adminAccountsListSchema),
  aggregate: () =>
    api.get("/v1/admin/portfolios/aggregate", adminAggregateSchema),
  refreshAll: () =>
    api.post(
      "/v1/admin/portfolios/refresh-all",
      undefined,
      refreshAllResponseSchema
    ),
  refreshOne: (accountId: string) =>
    api.post(
      `/v1/admin/portfolios/${accountId}/refresh`,
      undefined,
      z.object({ jobId: z.string(), accountId: z.string().uuid() })
    ),
};
