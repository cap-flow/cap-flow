import { useQuery } from "@tanstack/react-query";

import { adminQueueApi } from "./api";

export function useQueueStatus(refetchIntervalMs: number = 5000) {
  return useQuery({
    queryKey: ["admin", "queue", "status"] as const,
    queryFn: () => adminQueueApi.status(),
    refetchInterval: refetchIntervalMs,
  });
}
