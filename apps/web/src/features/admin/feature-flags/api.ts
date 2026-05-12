import { z } from "zod";

import { api } from "@/lib/api/client";

export const flagScopeSchema = z.enum(["global", "account", "user"]);
export type FlagScope = z.infer<typeof flagScopeSchema>;

export const flagRowSchema = z.object({
  id: z.string().uuid(),
  key: z.string(),
  scope: flagScopeSchema,
  scopeRefId: z.string().uuid().nullable(),
  enabled: z.boolean(),
  payload: z.unknown().nullable(),
  updatedAt: z.string(),
});
export type FlagRow = z.infer<typeof flagRowSchema>;

const flagListSchema = z.array(flagRowSchema);

export interface UpsertFlagInput {
  readonly scope: FlagScope;
  readonly scopeRefId: string | null;
  readonly enabled: boolean;
  readonly payload?: Record<string, unknown> | null;
}

export const adminFeatureFlagsApi = {
  list: () => api.get("/v1/admin/feature-flags", flagListSchema),
  byKey: (key: string) =>
    api.get(`/v1/admin/feature-flags/${encodeURIComponent(key)}`, flagListSchema),
  upsert: (key: string, body: UpsertFlagInput) =>
    api.put(
      `/v1/admin/feature-flags/${encodeURIComponent(key)}`,
      body,
      flagRowSchema
    ),
  delete: (id: string) =>
    api.delete(`/v1/admin/feature-flags/${id}`, z.unknown()),
};
