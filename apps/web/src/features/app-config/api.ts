import { z } from "zod";

import { api } from "@/lib/api/client";

/**
 * Frontend-кнобы из backend app-settings (GET /v1/me/app-config).
 * Ключи — dotted (см. apps/api/.../app-settings.catalog.ts, scope:'frontend').
 * Схема `passthrough` — терпима к новым ключам без релиза веба.
 */
export const appConfigSchema = z
  .object({
    "debank.historyMaxPagesFirstLoad": z.number().optional(),
    "debank.historyMaxPagesIncremental": z.number().optional(),
    "frontend.autoRefreshMinIntervalMs": z.number().optional(),
  })
  .passthrough();

export type AppConfigRaw = z.infer<typeof appConfigSchema>;

export const appConfigApi = {
  get: () => api.get("/v1/me/app-config", appConfigSchema),
};
