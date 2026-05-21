import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { adminIntegrationsApi } from "./api";

const KEYS = {
  all: ["admin", "integrations"] as const,
  list: () => [...KEYS.all, "list"] as const,
};

export function useAdminIntegrations() {
  return useQuery({
    queryKey: KEYS.list(),
    queryFn: () => adminIntegrationsApi.list(),
    staleTime: 30_000,
  });
}

export function useUpdateIntegration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      adminIntegrationsApi.setSecret(key, value),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all }),
  });
}

export function useClearIntegration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => adminIntegrationsApi.clearSecret(key),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all }),
  });
}

/**
 * UCB B1: probe candidate CEX-proxy URL без сохранения. UI «Тест»
 * кнопка в Integrations dialog. Возвращает report со статусами по
 * каждой бирже (bybit/bingx/bitget).
 */
export function useTestCexProxy() {
  return useMutation({
    mutationFn: (value: string) => adminIntegrationsApi.testCexProxy(value),
  });
}

/** Register Telegram webhook with api.telegram.org (one-time). */
export function useSetupTelegramWebhook() {
  return useMutation({
    mutationFn: () => adminIntegrationsApi.setupTelegramWebhook(),
  });
}

/** Diagnostic: ping api.telegram.org/getMe through current proxy. */
export function useTestTelegramProxy() {
  return useMutation({
    mutationFn: () => adminIntegrationsApi.testTelegramProxy(),
  });
}

/**
 * Read-only diagnostic: getWebhookInfo через proxy. Возвращает url,
 * pending_update_count, last_error_date/message — best source of truth
 * для отладки «нажал /start — ничего не пришло».
 */
export function useTelegramWebhookInfo() {
  return useMutation({
    mutationFn: () => adminIntegrationsApi.getTelegramWebhookInfo(),
  });
}

/** Delete webhook у Telegram — для перехода на polling. */
export function useDeleteTelegramWebhook() {
  return useMutation({
    mutationFn: () => adminIntegrationsApi.deleteTelegramWebhook(),
  });
}
