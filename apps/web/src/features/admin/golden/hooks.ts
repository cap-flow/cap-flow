/**
 * React-query hooks for the admin golden-cases API (Epic A3).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { adminGoldenApi, type CreateGoldenBody } from "./api";

const KEYS = {
  all: ["admin-golden"] as const,
  list: (walletId?: string) => [...KEYS.all, "list", walletId ?? "*"] as const,
};

export function useGoldenCases(
  walletId?: string,
  opts?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: KEYS.list(walletId),
    queryFn: () => adminGoldenApi.list(walletId),
    staleTime: 60_000,
    // Admin-only endpoint — don't fire for non-admins (would 403).
    enabled: opts?.enabled ?? true,
  });
}

export function useCreateGoldenCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateGoldenBody) => adminGoldenApi.create(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEYS.all });
    },
  });
}
