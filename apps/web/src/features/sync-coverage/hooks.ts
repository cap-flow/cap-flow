/**
 * UCB B4: hook для sync coverage page.
 */
import { useQuery } from "@tanstack/react-query";

import { syncCoverageApi } from "./api";

export function useSyncCoverage(enabled: boolean) {
  return useQuery({
    queryKey: ["sync-coverage"],
    queryFn: () => syncCoverageApi.get(),
    enabled,
    staleTime: 30_000, // 30s — частый refresh для коротких циклов sync
  });
}
