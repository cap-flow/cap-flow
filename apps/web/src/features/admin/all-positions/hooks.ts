import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { adminAllPositionsApi, type ComputeMethodology } from "./api";

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
    mutationFn: (methodology: ComputeMethodology) => adminAllPositionsApi.computeAll(methodology),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin", "all-positions"] }),
  });
}
