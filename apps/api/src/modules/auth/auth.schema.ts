import { z } from "zod";

export const loginBodySchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});

export const impersonationInfoSchema = z.object({
  impersonatorId: z.string().uuid(),
  mode: z.enum(["view", "edit"]),
});

export const meResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  name: z.string(),
  role: z.enum(["admin", "user", "viewer"]),
  createdAt: z.string().datetime(),
  lastLoginAt: z.string().datetime().nullable(),
  /** Present iff the current session is an admin acting as this user.
   *  Frontend uses it to render the persistent "you're impersonating X" banner. */
  impersonation: impersonationInfoSchema.nullable(),
});

export const loginResponseSchema = z.object({
  accessToken: z.string(),
  expiresAt: z.string().datetime(),
  user: meResponseSchema,
});

export type LoginBody = z.infer<typeof loginBodySchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type LoginResponse = z.infer<typeof loginResponseSchema>;
