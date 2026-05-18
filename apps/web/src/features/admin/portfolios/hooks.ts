import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { adminPortfoliosApi } from "./api";

const KEYS = {
  all: ["admin", "portfolios"] as const,
  list: () => [...KEYS.all, "list"] as const,
  aggregate: () => [...KEYS.all, "aggregate"] as const,
};

export function useAdminPortfolios() {
  return useQuery({
    queryKey: KEYS.list(),
    queryFn: () => adminPortfoliosApi.list(),
  });
}

export function useAdminPortfoliosAggregate() {
  return useQuery({
    queryKey: KEYS.aggregate(),
    queryFn: () => adminPortfoliosApi.aggregate(),
  });
}

/**
 * Enqueue a refresh job for every active account, then schedule a delayed
 * refetch of the admin table so the new snapshot is visible without manual
 * reload. Jobs run async via BullMQ; typical wall-time per account is
 * 15-60 sec depending on DeBank pagination depth, so we poll twice
 * (after 5s and 30s) to catch the latest snapshot.
 */
export function useAdminPortfoliosRefreshAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => adminPortfoliosApi.refreshAll(),
    onSuccess: () => {
      // First poll: catches fast-completing accounts.
      window.setTimeout(() => {
        qc.invalidateQueries({ queryKey: KEYS.all });
      }, 5_000);
      // Second poll: catches slower DeBank pulls.
      window.setTimeout(() => {
        qc.invalidateQueries({ queryKey: KEYS.all });
      }, 30_000);
    },
  });
}

export function useAdminPortfolioRefreshOne() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) =>
      adminPortfoliosApi.refreshOne(accountId),
    onSuccess: () => {
      window.setTimeout(() => {
        qc.invalidateQueries({ queryKey: KEYS.all });
      }, 5_000);
      window.setTimeout(() => {
        qc.invalidateQueries({ queryKey: KEYS.all });
      }, 30_000);
    },
  });
}
