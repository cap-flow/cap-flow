import { z } from "zod";

/**
 * Admin: create invite.
 * - `email` optional: when omitted, invite is "open" — user enters their
 *   own email at /invite/:token (Phase S7 link-only flow).
 * - `ttlHours` optional → server default from env.
 * - `notes` optional — admin-private memo, also surfaced to the user as
 *   an opening message after they register.
 */
export const createInviteBodySchema = z.object({
  email: z.string().email().max(320).optional(),
  ttlHours: z.number().int().min(1).max(24 * 30).optional(),
  notes: z.string().max(2000).optional(),
});

/** Admin: list filter. */
export const listInvitesQuerySchema = z.object({
  status: z.enum(["pending", "consumed", "revoked", "expired"]).optional(),
});

/** Admin: response — token shown ONCE on create. */
export const inviteAdminResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email().nullable(),
  status: z.enum(["pending", "consumed", "revoked", "expired"]),
  expiresAt: z.string().datetime(),
  consumedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  notes: z.string().nullable(),
});

export const inviteCreatedResponseSchema = inviteAdminResponseSchema.extend({
  /** Raw token — shown once on create. Reconstruct the link with this. */
  token: z.string(),
  inviteUrl: z.string(),
});

export const inviteListResponseSchema = z.array(inviteAdminResponseSchema);

/**
 * Public: lookup by token — only safe fields.
 * `email` may be `null` for open invite links — frontend then renders
 * an email input on the registration form.
 */
export const invitePublicResponseSchema = z.object({
  email: z.string().email().nullable(),
  expiresAt: z.string().datetime(),
  /**
   * Admin-supplied opening note shown to the user on the registration
   * page (e.g. "Welcome to the closed beta, click the link to set up
   * your account").
   */
  notes: z.string().nullable(),
});

/**
 * Public: register from invite — invite token comes from URL param.
 * `email` is REQUIRED only when invite was created without a pre-bound email
 * (open invite). Server validates: if invite.email != null, the email field
 * is ignored; if invite.email == null, this field is mandatory.
 */
export const registerFromInviteBodySchema = z.object({
  email: z.string().email().max(320).optional(),
  password: z
    .string()
    .min(12, "Password must be at least 12 characters")
    .max(200),
  name: z.string().min(1).max(120).optional(),
});

export const tokenParamSchema = z.object({
  token: z.string().min(8).max(200),
});

export const inviteIdParamSchema = z.object({
  id: z.string().uuid(),
});

export type CreateInviteBody = z.infer<typeof createInviteBodySchema>;
export type ListInvitesQuery = z.infer<typeof listInvitesQuerySchema>;
export type RegisterFromInviteBody = z.infer<
  typeof registerFromInviteBodySchema
>;
