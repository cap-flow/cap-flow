import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { usersApi, type CreateUserInput } from "./api";

const KEYS = {
  all: ["users"] as const,
  list: () => [...KEYS.all, "list"] as const,
};

export function useUsers() {
  return useQuery({
    queryKey: KEYS.list(),
    queryFn: () => usersApi.list(),
  });
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateUserInput) => usersApi.create(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all }),
  });
}

export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => usersApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all }),
  });
}
