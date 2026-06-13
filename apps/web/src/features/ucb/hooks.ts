/**
 * B6 slice 2 — fetch the server-computed canonical positions for the active
 * account, gated on the per-user flag. Returns the raw response + flag state;
 * the adopt/fallback decision (incl. methodology + wallet-set match) lives in
 * the pure `shouldAdoptServerPositions` so `useComputedPositions` can compare
 * against its just-computed client positions.
 */
import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useActiveAccount } from "@/features/accounts/hooks";
import { useResolvedFeatureFlag } from "@/features/feature-flags/hooks";

import { ucbApi, type ServePositionsDto } from "./api";
import { shouldServerRecompute } from "./serve-decision";

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

/**
 * Server-only UX: когда серверного результата нет или он не подходит, сервер
 * пересчитывает аккаунт МГНОВЕННО, не дожидаясь worker-refresh. Покрывает:
 *   - `no_shadow`     — НОВЫЙ аккаунт, воркер ещё не считал (инцидент moximko
 *                       2026-06-12: подключил кошелёк → пустая таблица навсегда,
 *                       т.к. server-only выключил браузерный fallback);
 *   - `not_served`    — сервер по иной причине не отдал;
 *   - `methodology_mismatch` — тогл методики ≠ серверной;
 *   - `stale`         — снапшот свежее последнего shadow.
 * Гард от циклов: один запуск на (accountId, методика, причина); неудача не
 * ретраится автоматически (бейдж остаётся честным).
 */
export function useServerRecomputeOnMismatch(args: {
  active: boolean;
  reason: string;
  lotMethodology: string;
}): void {
  const account = useActiveAccount();
  const accountId = account?.id ?? null;
  const queryClient = useQueryClient();
  const firedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!args.active || !accountId) return;
    if (!shouldServerRecompute(args.reason)) return;
    const key = `${accountId}|${args.lotMethodology}|${args.reason}`;
    if (firedFor.current === key) return;
    firedFor.current = key;
    void ucbApi
      .recomputeServerPositions(accountId)
      .then(() =>
        queryClient.invalidateQueries({
          queryKey: ["ucb-server-positions", accountId],
        }),
      )
      .catch(() => {
        /* fail-soft: бейдж продолжает показывать причину */
      });
  }, [args.active, args.reason, args.lotMethodology, accountId, queryClient]);
}
