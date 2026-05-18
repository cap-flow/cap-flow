import { z } from "zod";

import { api } from "@/lib/api/client";
import { loginResponseSchema } from "@/features/auth/api";

/**
 * Public invite endpoints. The admin-side `features/admin/invites/api.ts`
 * already exists with CRUD; this module focuses on the **invitee** flow:
 * preview the invitation, then register (becomes the auth response so we
 * can drop the user straight into the app).
 */

export const invitePreviewSchema = z.object({
  /** `null` for open invites — the user supplies their email at registration. */
  email: z.string().email().nullable(),
  expiresAt: z.string(),
  /** Admin-supplied opening note shown to the user (optional). */
  notes: z.string().nullable(),
});
export type InvitePreview = z.infer<typeof invitePreviewSchema>;

export interface RegisterFromInviteInput {
  /** Required for open invites (where preview.email is null). */
  readonly email?: string;
  readonly password: string;
  readonly name?: string;
}

export const publicInvitesApi = {
  /** GET /api/v1/invites/:token — read-only preview, no auth. */
  preview: (token: string) =>
    api.get(`/v1/invites/${encodeURIComponent(token)}`, invitePreviewSchema),

  /** POST /api/v1/invites/:token/register — creates user + auto-login. */
  register: (token: string, body: RegisterFromInviteInput) =>
    api.postPublic(
      `/v1/invites/${encodeURIComponent(token)}/register`,
      body,
      loginResponseSchema
    ),
};
