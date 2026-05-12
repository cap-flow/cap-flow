import { useQuery } from "@tanstack/react-query";

import { adminPortfoliosApi } from "./api";

const KEYS = {
  all: ["admin", "portfolios"] as const,
  list: () => [...KEYS.all, "list"] as const,
  aggregate: () => [...KEYS.all, "aggregate"] as const,
};

export function useAdminPortfolios() {
  return useQuery({
    queryKey: KEYS.list(),
    queryFn: () => adminPortfoliosApi.list(),
  });
}

export function useAdminPortfoliosAggregate() {
  return useQuery({
    queryKey: KEYS.aggregate(),
    queryFn: () => adminPortfoliosApi.aggregate(),
  });
}
