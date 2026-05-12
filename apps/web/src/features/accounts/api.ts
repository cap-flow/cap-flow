import { z } from "zod";

import { api } from "@/lib/api/client";

/**
 * Slim accounts client — just enough for user-side pages to resolve their
 * own primary account id (everything else hangs off that). Admin-side
 * accounts management lives separately under `features/admin/users` etc.
 */
export const accountSchema = z.object({
  id: z.string().uuid(),
  ownerId: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  isPrimary: z.boolean(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Account = z.infer<typeof accountSchema>;

const accountListSchema = z.array(accountSchema);

export const accountsApi = {
  listMine: () => api.get("/v1/accounts", accountListSchema),
};
