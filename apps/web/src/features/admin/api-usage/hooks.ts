import { useQuery } from "@tanstack/react-query";

import { adminApiUsageApi } from "./api";

export function useApiUsageSummary(hours: number) {
  return useQuery({
    queryKey: ["admin", "api-usage", "summary", hours] as const,
    queryFn: () => adminApiUsageApi.summary(hours),
  });
}

export function useApiUsageRecent(limit: number) {
  return useQuery({
    queryKey: ["admin", "api-usage", "recent", limit] as const,
    queryFn: () => adminApiUsageApi.recent(limit),
  });
}

export function useApiUsageQuotas(userId: string | null) {
  return useQuery({
    queryKey: ["admin", "api-usage", "quotas", userId ?? ""] as const,
    queryFn: () => adminApiUsageApi.quotas(userId as string),
    enabled: !!userId,
  });
}
