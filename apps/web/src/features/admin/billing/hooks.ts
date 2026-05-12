import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { adminBillingApi } from "./api";

export const adminBillingKeys = {
  byUser: (userId: string) => ["admin", "billing", userId] as const,
};

export function useAdminUserBilling(userId: string | null) {
  return useQuery({
    queryKey: userId ? adminBillingKeys.byUser(userId) : ["admin", "billing", "none"],
    queryFn: () => adminBillingApi.get(userId!),
    enabled: !!userId,
    staleTime: 30_000,
  });
}

export function useAdminCredit(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ amountUsd, note }: { amountUsd: number; note?: string }) =>
      adminBillingApi.credit(userId, amountUsd, note),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: adminBillingKeys.byUser(userId) }),
  });
}

export function useAdminRefund(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ paymentId, note }: { paymentId: string; note?: string }) =>
      adminBillingApi.refund(userId, paymentId, note),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: adminBillingKeys.byUser(userId) }),
  });
}
