import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { adminFeatureFlagsApi, type UpsertFlagInput } from "./api";

const KEYS = {
  all: ["admin", "feature-flags"] as const,
};

export function useFeatureFlags() {
  return useQuery({
    queryKey: KEYS.all,
    queryFn: () => adminFeatureFlagsApi.list(),
    staleTime: 30_000,
  });
}

export function useUpsertFeatureFlag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, body }: { key: string; body: UpsertFlagInput }) =>
      adminFeatureFlagsApi.upsert(key, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all }),
  });
}

export function useDeleteFeatureFlag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminFeatureFlagsApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all }),
  });
}
