import { z } from "zod";

import { api } from "@/lib/api/client";

export const inviteStatusSchema = z.enum([
  "pending",
  "consumed",
  "revoked",
  "expired",
]);
export type InviteStatus = z.infer<typeof inviteStatusSchema>;

export const inviteRowSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email().nullable(),
  status: inviteStatusSchema,
  expiresAt: z.string().datetime(),
  consumedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  notes: z.string().nullable(),
});
export type InviteRow = z.infer<typeof inviteRowSchema>;

export const inviteCreatedSchema = inviteRowSchema.extend({
  token: z.string(),
  inviteUrl: z.string(),
});
export type InviteCreated = z.infer<typeof inviteCreatedSchema>;

const inviteListSchema = z.array(inviteRowSchema);

export interface CreateInviteInput {
  /** Optional — omit for open invite link (recipient enters email at registration). */
  readonly email?: string;
  readonly ttlHours?: number;
  readonly notes?: string;
}

function toQuery(status: InviteStatus | ""): string {
  if (!status) return "";
  return `?status=${status}`;
}

export const adminInvitesApi = {
  list: (status: InviteStatus | "" = "") =>
    api.get(`/v1/admin/invites${toQuery(status)}`, inviteListSchema),
  create: (input: CreateInviteInput) =>
    api.post("/v1/admin/invites", input, inviteCreatedSchema),
  revoke: (id: string) => api.delete(`/v1/admin/invites/${id}`),
};
