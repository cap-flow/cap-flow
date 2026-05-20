import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { telegramApi } from "./api";

const KEY = ["me", "telegram"] as const;

export function useTelegramStatus() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => telegramApi.status(),
    staleTime: 30_000,
    // Когда юзер только что нажал «Авторизоваться» и ждёт пока бот
    // подтвердит /start <code> — поллим status каждые 3с, чтобы UI
    // самостоятельно переключился с pending → linked без F5. Отключается
    // когда state стал linked или none.
    refetchInterval: (q) => {
      const s = q.state.data?.state;
      return s === "pending" ? 3000 : false;
    },
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
