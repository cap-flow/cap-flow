import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  adminInvitesApi,
  type CreateInviteInput,
  type InviteStatus,
} from "./api";

const KEYS = {
  all: ["admin", "invites"] as const,
  list: (status: InviteStatus | "") => [...KEYS.all, "list", status] as const,
};

export function useInvites(status: InviteStatus | "") {
  return useQuery({
    queryKey: KEYS.list(status),
    queryFn: () => adminInvitesApi.list(status),
  });
}

export function useCreateInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateInviteInput) => adminInvitesApi.create(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all }),
  });
}

export function useRevokeInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminInvitesApi.revoke(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all }),
  });
}
