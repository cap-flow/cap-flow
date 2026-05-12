import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { billingApi, type CryptoNetwork } from "./api";

export const billingKeys = {
  summary: ["billing", "summary"] as const,
  addresses: (network: CryptoNetwork) =>
    ["billing", "address", network] as const,
  payments: ["billing", "payments"] as const,
};

export function useBillingSummary() {
  return useQuery({
    queryKey: billingKeys.summary,
    queryFn: () => billingApi.summary(),
    staleTime: 30_000,
  });
}

export function usePaymentsHistory() {
  return useQuery({
    queryKey: billingKeys.payments,
    queryFn: () => billingApi.payments(),
    staleTime: 30_000,
  });
}

export function useAllocateAddress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (network: CryptoNetwork) => billingApi.allocateAddress(network),
    onSuccess: (_data, network) => {
      qc.invalidateQueries({ queryKey: billingKeys.addresses(network) });
    },
  });
}
