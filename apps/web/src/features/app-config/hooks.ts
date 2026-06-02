import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/features/auth/AuthProvider";

import { appConfigApi } from "./api";

/**
 * Резолвленные frontend-кнобы. Всегда заданы (fallback-дефолты до загрузки и
 * при ошибке), чтобы консьюмеры не ветвились на undefined.
 */
export interface AppConfig {
  /** Макс. страниц истории DeBank при ПЕРВОМ бэкфилле (полная история). */
  historyMaxPagesFirstLoad: number;
  /** Макс. страниц при инкрементной дозагрузке. */
  historyMaxPagesIncremental: number;
  /** Мин. интервал авто-рефреша (мс). */
  autoRefreshMinIntervalMs: number;
  /** Мин. интервал между ручными обновлениями кнопкой «Обновить» (мс). 0 = выкл. */
  manualRefreshMinIntervalMs: number;
}

/** Дефолты — синхронны с catalog defaults на бэкенде. */
export const APP_CONFIG_DEFAULTS: AppConfig = {
  historyMaxPagesFirstLoad: 500,
  historyMaxPagesIncremental: 5,
  autoRefreshMinIntervalMs: 60 * 60 * 1000,
  manualRefreshMinIntervalMs: 60 * 60 * 1000,
};

/**
 * Тянет frontend-кнобы из backend (раз в сессию, staleTime 5 мин). До ответа /
 * при ошибке отдаёт дефолты. Требует логина (роут authed).
 */
export function useAppConfig(): { config: AppConfig; loading: boolean } {
  const { user } = useAuth();
  const q = useQuery({
    queryKey: ["app-config"],
    queryFn: () => appConfigApi.get(),
    enabled: !!user?.id,
    staleTime: 5 * 60 * 1000,
  });

  const raw = q.data;
  const config: AppConfig = {
    historyMaxPagesFirstLoad:
      raw?.["debank.historyMaxPagesFirstLoad"] ??
      APP_CONFIG_DEFAULTS.historyMaxPagesFirstLoad,
    historyMaxPagesIncremental:
      raw?.["debank.historyMaxPagesIncremental"] ??
      APP_CONFIG_DEFAULTS.historyMaxPagesIncremental,
    autoRefreshMinIntervalMs:
      raw?.["frontend.autoRefreshMinIntervalMs"] ??
      APP_CONFIG_DEFAULTS.autoRefreshMinIntervalMs,
    manualRefreshMinIntervalMs:
      raw?.["frontend.manualRefreshMinIntervalMs"] ??
      APP_CONFIG_DEFAULTS.manualRefreshMinIntervalMs,
  };

  return { config, loading: q.isLoading };
}
