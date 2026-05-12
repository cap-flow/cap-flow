import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { telegramApi } from "./api";

const KEY = ["me", "telegram"] as const;

export function useTelegramStatus() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => telegramApi.status(),
    staleTime: 30_000,
  });
}

export function useStartTelegramLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => telegramApi.start(),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUnlinkTelegram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => telegramApi.unlink(),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
