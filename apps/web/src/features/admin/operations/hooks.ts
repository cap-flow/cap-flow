import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { adminOperationsApi, type AdminOperationsParams } from "./api";

const KEYS = {
  all: ["admin", "operations"] as const,
  list: (p: AdminOperationsParams) => [...KEYS.all, "list", p] as const,
  facets: () => [...KEYS.all, "facets"] as const,
};

export function useAdminOperations(params: AdminOperationsParams) {
  return useQuery({
    queryKey: KEYS.list(params),
    queryFn: () => adminOperationsApi.list(params),
    // Keep the previous page visible while the next one loads — avoids the
    // table flashing empty on every filter/page change.
    placeholderData: keepPreviousData,
  });
}

export function useAdminOperationFacets() {
  return useQuery({
    queryKey: KEYS.facets(),
    queryFn: () => adminOperationsApi.facets(),
    staleTime: 5 * 60 * 1000,
  });
}
