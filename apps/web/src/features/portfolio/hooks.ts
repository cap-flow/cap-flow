import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  portfolioApi,
  type AccountRefreshStatus,
  type SnapshotMetrics,
} from "./api";

/**
 * Authoritative portfolio data for an account, sourced from
 * `portfolio_snapshots` on the server. Refreshed by the BullMQ worker
 * (hourly cron + manual triggers via {@link useTriggerAccountRefresh}).
 *
 * Returns `undefined` while loading and `null` if no snapshot has been
 * written yet (worker hasn't run for this account).
 */
export function useAccountSnapshot(
  accountId: string | undefined,
): {
  status: AccountRefreshStatus | undefined;
  metrics: SnapshotMetrics | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
} {
  const q = useQuery({
    queryKey: ["account-refresh-status", accountId],
    queryFn: () => portfolioApi.refreshStatus(accountId!),
    enabled: Boolean(accountId),
    // Stale enough that the dashboard doesn't churn re-renders, fresh
    // enough that the user sees worker-written updates without manual
    // refresh.
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
  });

  return {
    status: q.data,
    metrics: q.data?.lastSnapshot?.metrics ?? null,
    isLoading: q.isLoading,
    error: (q.error as Error | null) ?? null,
    refetch: q.refetch,
  };
}

/**
 * Enqueue a manual refresh job for the account. Mutation resolves once
 * the API has enqueued; the job itself completes asynchronously in the
 * worker — poll via {@link useAccountSnapshot}'s `refetchInterval` to
 * see fresh data, or call `invalidate` on the same key.
 */
export function useTriggerAccountRefresh(accountId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => portfolioApi.triggerRefresh(accountId!),
    onSuccess: () => {
      // Give the worker ~3s to start picking up the job, then re-poll.
      window.setTimeout(() => {
        void qc.invalidateQueries({
          queryKey: ["account-refresh-status", accountId],
        });
      }, 3000);
    },
  });
}
