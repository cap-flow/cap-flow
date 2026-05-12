import { z } from "zod";

/** Admin: create invite. ttlHours optional → server default from env. */
export const createInviteBodySchema = z.object({
  email: z.string().email().max(320),
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
  email: z.string().email(),
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

/** Public: lookup by token — only safe fields. */
export const invitePublicResponseSchema = z.object({
  email: z.string().email(),
  expiresAt: z.string().datetime(),
});

/** Public: register from invite — invite token comes from URL param. */
export const registerFromInviteBodySchema = z.object({
  password: z
    .string()
    .min(12, "Password must be at least 12 characters")
    .max(200),
  name: z.string().min(1).max(120),
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
