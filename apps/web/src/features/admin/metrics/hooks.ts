import { useQuery } from "@tanstack/react-query";

import { adminMetricsApi } from "./api";

const KEYS = {
  all: ["admin", "metrics"] as const,
  saas: () => [...KEYS.all, "saas"] as const,
};

export function useSaasMetrics() {
  return useQuery({
    queryKey: KEYS.saas(),
    queryFn: () => adminMetricsApi.saas(),
  });
}
