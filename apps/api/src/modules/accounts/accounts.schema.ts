import { z } from "zod";

export const accountIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const createAccountBodySchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
});

export const updateAccountBodySchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
});

export const accountResponseSchema = z.object({
  id: z.string().uuid(),
  ownerId: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  isPrimary: z.boolean(),
  archivedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const accountListResponseSchema = z.array(accountResponseSchema);

export type AccountIdParam = z.infer<typeof accountIdParamSchema>;
export type CreateAccountBody = z.infer<typeof createAccountBodySchema>;
export type UpdateAccountBody = z.infer<typeof updateAccountBodySchema>;
export type AccountResponse = z.infer<typeof accountResponseSchema>;
