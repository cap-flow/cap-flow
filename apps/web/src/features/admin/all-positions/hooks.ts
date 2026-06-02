import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { adminAllPositionsApi } from "./api";

export function useAllPositions() {
  return useQuery({
    queryKey: ["admin", "all-positions"] as const,
    queryFn: () => adminAllPositionsApi.list(),
    refetchInterval: 60_000, // auto-refresh as the worker recomputes
  });
}

export function useComputeAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => adminAllPositionsApi.computeAll(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin", "all-positions"] }),
  });
}
