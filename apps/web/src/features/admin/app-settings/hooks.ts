import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { adminAppSettingsApi } from "./api";

const KEYS = {
  all: ["admin", "app-settings"] as const,
  list: () => [...KEYS.all, "list"] as const,
};

export function useAdminAppSettings() {
  return useQuery({
    queryKey: KEYS.list(),
    queryFn: () => adminAppSettingsApi.list(),
    staleTime: 15_000,
  });
}

export function useUpdateAppSetting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      key,
      value,
    }: {
      key: string;
      value: number | boolean | string;
    }) => adminAppSettingsApi.set(key, value),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEYS.all });
      // app-config (frontend-кнобы) тоже мог измениться — инвалидируем.
      void qc.invalidateQueries({ queryKey: ["app-config"] });
    },
  });
}

export function useResetAppSetting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => adminAppSettingsApi.reset(key),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEYS.all });
      void qc.invalidateQueries({ queryKey: ["app-config"] });
    },
  });
}
