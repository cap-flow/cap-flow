/**
 * Public hooks для resolved feature flags на frontend.
 *
 * Использует react-query для кэширования (30s stale, чтобы быстро ловить
 * toggle от админа). Backend resolves с приоритетом:
 *   user-scope → account-scope → global → default(false).
 */

import { useQuery } from "@tanstack/react-query";

import { publicFeatureFlagsApi } from "./api";
import { useActiveAccount } from "@/features/accounts/hooks";

const KEYS = {
  resolve: (keys: readonly string[], accountId: string | null | undefined) =>
    ["me", "feature-flags", "resolve", [...keys].sort().join(","), accountId] as const,
};

/**
 * Resolve one or more flag keys for the current user. Returns a Map<key, enabled>.
 *
 * При первом render'е до получения response — все ключи возвращаются как
 * `false` (safe default). Это значит экспериментальные фичи никогда не
 * мерцают как "включённые" пока серверный ответ не подтвердит.
 */
export function useResolvedFeatureFlags(
  keys: readonly string[],
): { enabled: Map<string, boolean>; loading: boolean } {
  const account = useActiveAccount();
  const accountId = account?.id ?? null;

  const query = useQuery({
    queryKey: KEYS.resolve(keys, accountId),
    queryFn: () => publicFeatureFlagsApi.resolve(keys, accountId ?? undefined),
    staleTime: 30_000,
    enabled: keys.length > 0,
  });

  const enabled = new Map<string, boolean>();
  for (const k of keys) enabled.set(k, false); // default before fetch
  for (const r of query.data ?? []) {
    enabled.set(r.key, r.enabled);
  }
  return { enabled, loading: query.isLoading };
}

/**
 * Convenience: resolve a single flag key.
 */
export function useResolvedFeatureFlag(key: string): {
  enabled: boolean;
  loading: boolean;
} {
  const { enabled, loading } = useResolvedFeatureFlags([key]);
  return { enabled: enabled.get(key) ?? false, loading };
}
