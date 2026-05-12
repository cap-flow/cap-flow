import { useQuery } from "@tanstack/react-query";

import { adminAuditApi, type AuditFilter } from "./api";

const KEYS = {
  all: ["admin", "audit"] as const,
  list: (f: AuditFilter) => [...KEYS.all, "list", f] as const,
  counts: (hours: number) => [...KEYS.all, "counts", hours] as const,
};

export function useAuditEntries(filter: AuditFilter) {
  return useQuery({
    queryKey: KEYS.list(filter),
    queryFn: () => adminAuditApi.list(filter),
  });
}

export function useAuditActionCounts(hours: number) {
  return useQuery({
    queryKey: KEYS.counts(hours),
    queryFn: () => adminAuditApi.actionCounts(hours),
  });
}
