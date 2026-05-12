import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  notificationsApi,
  type UpsertSubscriptionInput,
} from "./api";

const KEY = ["me", "notifications"] as const;

export function useNotificationSubscriptions() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => notificationsApi.list(),
    staleTime: 30_000,
  });
}

export function useUpsertSubscription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertSubscriptionInput) =>
      notificationsApi.upsert(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
