import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  adminUsersApi,
  type AdminUserRole,
  type AdminUserStatus,
  type ListFilter,
} from "./api";

const KEYS = {
  all: ["admin", "users"] as const,
  list: (filter: ListFilter) => [...KEYS.all, "list", filter] as const,
};

export function useAdminUsers(filter: ListFilter) {
  return useQuery({
    queryKey: KEYS.list(filter),
    queryFn: () => adminUsersApi.list(filter),
  });
}

export function useSetUserStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: AdminUserStatus }) =>
      adminUsersApi.setStatus(id, status),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all }),
  });
}

export function useSetUserRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, role }: { id: string; role: AdminUserRole }) =>
      adminUsersApi.setRole(id, role),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all }),
  });
}

export function useImpersonateUser() {
  return useMutation({
    mutationFn: (id: string) => adminUsersApi.impersonate(id),
  });
}
