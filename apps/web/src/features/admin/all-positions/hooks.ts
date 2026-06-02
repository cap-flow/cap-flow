import { useQuery } from "@tanstack/react-query";

import { adminAllPositionsApi } from "./api";

export function useAllPositions() {
  return useQuery({
    queryKey: ["admin", "all-positions"] as const,
    queryFn: () => adminAllPositionsApi.list(),
    refetchInterval: 60_000, // auto-refresh as the worker recomputes
  });
}
