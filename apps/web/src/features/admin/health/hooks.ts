import { useQuery } from "@tanstack/react-query";

import { adminHealthApi } from "./api";

export function useHealthStatus() {
  return useQuery({
    queryKey: ["admin", "health"] as const,
    queryFn: () => adminHealthApi.status(),
    // 15s refetch — health page обычно открыта недолго, частый refresh ок.
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
}
