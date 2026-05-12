import { z } from "zod";

import { api } from "@/lib/api/client";

export const userStatusSchema = z.enum(["active", "pending", "blocked"]);
export const userRoleSchema = z.enum(["admin", "user", "viewer"]);
export type AdminUserStatus = z.infer<typeof userStatusSchema>;
export type AdminUserRole = z.infer<typeof userRoleSchema>;

export const adminUserRowSchema = z.object({
  id: z.string().uuid(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  role: userRoleSchema,
  status: userStatusSchema,
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
  accountCount: z.number(),
  lastSnapshotAt: z.string().nullable(),
  lastSnapshotUsd: z.number().nullable(),
});
export type AdminUserRow = z.infer<typeof adminUserRowSchema>;

const adminUserListSchema = z.array(adminUserRowSchema);

const baseUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  role: userRoleSchema,
  status: userStatusSchema,
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
});
export type AdminBaseUser = z.infer<typeof baseUserSchema>;

const impersonateResponseSchema = z.object({
  accessToken: z.string(),
  expiresAt: z.string(),
  impersonatedUser: baseUserSchema,
  mode: z.literal("view"),
});
export type ImpersonateResponse = z.infer<typeof impersonateResponseSchema>;

export interface ListFilter {
  readonly status?: AdminUserStatus | undefined;
  readonly role?: AdminUserRole | undefined;
  readonly search?: string | undefined;
}

function toQuery(f: ListFilter): string {
  const p = new URLSearchParams();
  if (f.status) p.set("status", f.status);
  if (f.role) p.set("role", f.role);
  if (f.search && f.search.trim()) p.set("search", f.search.trim());
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const adminUsersApi = {
  list: (filter: ListFilter = {}) =>
    api.get(`/v1/admin/users${toQuery(filter)}`, adminUserListSchema),

  setStatus: (id: string, status: AdminUserStatus) =>
    api.patch(`/v1/admin/users/${id}/status`, { status }, baseUserSchema),

  setRole: (id: string, role: AdminUserRole) =>
    api.patch(`/v1/admin/users/${id}/role`, { role }, baseUserSchema),

  impersonate: (id: string) =>
    api.post<ImpersonateResponse, undefined>(
      `/v1/admin/users/${id}/impersonate`,
      undefined,
      impersonateResponseSchema
    ),
};
