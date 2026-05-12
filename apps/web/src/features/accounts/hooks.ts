import { useQuery } from "@tanstack/react-query";

import { accountsApi, type Account } from "./api";

export function useMyAccounts() {
  return useQuery({
    queryKey: ["accounts", "mine"],
    queryFn: () => accountsApi.listMine(),
    staleTime: 60_000,
  });
}

/** Convenience: return the (first) primary account, undefined while loading. */
export function usePrimaryAccount(): Account | null | undefined {
  const q = useMyAccounts();
  if (q.isLoading) return undefined;
  return q.data?.find((a) => a.isPrimary) ?? null;
}
