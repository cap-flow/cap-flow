import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { adminAnomalyApi } from "./api";

const KEY = ["admin", "anomaly", "flags"] as const;

export function useAnomalyFlags(params: { accountId?: string; status?: string }) {
  return useQuery({
    queryKey: [...KEY, params] as const,
    queryFn: () => adminAnomalyApi.list(params),
  });
}

export function useAnomalyScan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (account: string) => adminAnomalyApi.scan(account),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
}
