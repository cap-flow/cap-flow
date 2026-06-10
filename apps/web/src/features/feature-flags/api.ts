/**
 * Public API client для resolved feature flags (GET /me/feature-flags).
 *
 * В отличие от `features/admin/feature-flags/api.ts` (который для CRUD
 * в admin UI), этот клиент — для **рендеринга**: запросить список ключей
 * и узнать enabled/disabled для текущего юзера.
 *
 * Backend resolves with precedence: user-scope → account-scope → global → default(false).
 */

import { z } from "zod";

import { api } from "@/lib/api/client";

export const resolvedFeatureFlagSchema = z.object({
  key: z.string(),
  enabled: z.boolean(),
  source: z.enum(["global", "account", "user", "default"]),
  payload: z.unknown().nullable(),
});
export type ResolvedFeatureFlag = z.infer<typeof resolvedFeatureFlagSchema>;

const responseSchema = z.array(resolvedFeatureFlagSchema);

export const publicFeatureFlagsApi = {
  /**
   * Запросить resolved values для нескольких ключей одним round-trip.
   * Backend cap'ит max 50 ключей в одном запросе.
   *
   * @param keys — список ключей (e.g. ["capflow.feature.lendingAudit"])
   * @param accountId — опциональный accountId для account-scope resolution
   */
  async resolve(
    keys: readonly string[],
    accountId?: string,
  ): Promise<ResolvedFeatureFlag[]> {
    if (keys.length === 0) return [];
    const params = new URLSearchParams({
      keys: keys.join(","),
    });
    if (accountId) params.set("accountId", accountId);
    // ⚠ Фикс 2026-06-10: api.get ТРЕБУЕТ schema вторым аргументом (он сам
    // делает schema.parse). Вызов без неё падал ПОСЛЕ fetch'а
    // («Cannot read properties of undefined (reading 'parse')») → query
    // вечно в error → ВСЕ публичные фиче-флаги резолвились в false на
    // фронте (B6-адопция serverCanonical никогда не включалась).
    return api.get(`/v1/me/feature-flags?${params.toString()}`, responseSchema);
  },
};
