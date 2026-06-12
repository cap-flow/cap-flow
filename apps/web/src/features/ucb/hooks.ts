/**
 * B6 slice 2 — fetch the server-computed canonical positions for the active
 * account, gated on the per-user flag. Returns the raw response + flag state;
 * the adopt/fallback decision (incl. methodology + wallet-set match) lives in
 * the pure `shouldAdoptServerPositions` so `useComputedPositions` can compare
 * against its just-computed client positions.
 */
import { useQuery } from "@tanstack/react-query";

import { useActiveAccount } from "@/features/accounts/hooks";
import { useResolvedFeatureFlag } from "@/features/feature-flags/hooks";

import { ucbApi, type ServePositionsDto } from "./api";

/** Per-user serving flag (default OFF). Mirrors the server route constant. */
export const UCB_SERVER_CANONICAL_FLAG = "capflow.feature.ucbServerCanonical";

/**
 * Server-only режим (директива owner 2026-06-12): браузер НЕ выполняет свою
 * цепочку overrides вообще — позиции только с сервера; при не-served список
 * пуст с видимой причиной (бейдж), клиентского пересчёта нет.
 */
export const UCB_SERVER_ONLY_FLAG = "capflow.feature.ucbServerOnly";

export function useServerCanonicalQuery(): {
  flagEnabled: boolean;
  /** `ucbServerOnly` активен (подразумевает canonical). */
  serverOnly: boolean;
  data: ServePositionsDto | undefined;
} {
  const { enabled: canonicalEnabled } = useResolvedFeatureFlag(
    UCB_SERVER_CANONICAL_FLAG,
  );
  const { enabled: serverOnly } = useResolvedFeatureFlag(UCB_SERVER_ONLY_FLAG);
  // server-only без canonical бессмыслен — считаем canonical включённым.
  const flagEnabled = canonicalEnabled || serverOnly;
  const account = useActiveAccount();
  const accountId = account?.id ?? null;

  const query = useQuery({
    queryKey: ["ucb-server-positions", accountId],
    queryFn: ({ signal }) => {
      if (!accountId) throw new Error("ucb positions: no active account");
      return ucbApi.getServerPositions(accountId, signal);
    },
    enabled: flagEnabled && !!accountId,
    staleTime: 30_000,
  });

  return { flagEnabled, serverOnly, data: query.data };
}
