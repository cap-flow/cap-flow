/**
 * UCB B5.3: React Query hooks для server-side chain-ops cache.
 *
 * `useSyncChainOps` — fire-and-forget после успешного DeBank/Helius pull.
 *   Используется в `LoadedWalletsProvider.load()`. Не блокирует UI:
 *   если sync падает (network), client cache всё ещё работает.
 *
 * `useChainOpsStatus` — для UI badge "synced to cloud · 156 ops · 2h ago".
 *   Stale time 60s — этот status не критичен real-time.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { chainOpsApi, type ChainOpInput } from "./api";

const KEYS = {
  all: ["chain-ops"] as const,
  list: (walletId: string) => [...KEYS.all, "list", walletId] as const,
  status: (walletId: string) => [...KEYS.all, "status", walletId] as const,
  graphInternalTransfers: () =>
    [...KEYS.all, "graph", "internal-transfers"] as const,
  annotations: () => [...KEYS.all, "annotations"] as const,
};

export function useSyncChainOps() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      walletId,
      ops,
    }: {
      walletId: string;
      ops: readonly ChainOpInput[];
    }) => chainOpsApi.syncBatch(walletId, ops),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: KEYS.status(vars.walletId) });
      qc.invalidateQueries({ queryKey: KEYS.list(vars.walletId) });
    },
  });
}

export function useChainOpsStatus(walletId: string | null) {
  return useQuery({
    queryKey: walletId ? KEYS.status(walletId) : ["chain-ops", "status", "none"],
    queryFn: () => chainOpsApi.status(walletId!),
    enabled: !!walletId,
    staleTime: 60_000,
  });
}

/**
 * UCB A1: server-side cross-wallet internal transfer detection (Layer 1).
 * Stale time 5 min — pairs не меняются часто, эти данные supplement'тят
 * client-side `findInternalTransferPairs` heuristic detector.
 */
export function useGraphInternalTransfers(enabled: boolean) {
  return useQuery({
    queryKey: KEYS.graphInternalTransfers(),
    queryFn: () => chainOpsApi.graphInternalTransfers(),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/**
 * UCB A3: all user annotations (bulk-load для apply'я к ops в памяти).
 * Stale 1 min — частые mutations должны быстро инвалидать кэш.
 */
export function useAnnotations(enabled: boolean) {
  return useQuery({
    queryKey: KEYS.annotations(),
    queryFn: () => chainOpsApi.annotations.listAll(),
    enabled,
    staleTime: 60_000,
  });
}

export function useUpsertAnnotation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      opId,
      body,
    }: {
      opId: string;
      body: import("./api").AnnotationUpsertBody;
    }) => chainOpsApi.annotations.upsert(opId, body),
    onSuccess: () => {
      // Invalidate annotations + graph (которые могут зависеть от
      // isInternalTransfer override).
      qc.invalidateQueries({ queryKey: KEYS.annotations() });
      qc.invalidateQueries({ queryKey: KEYS.graphInternalTransfers() });
    },
  });
}

/**
 * Composite-key variant — для случая когда client не знает chain_op UUID
 * (op ещё не успел доехать до annotations-cache). Server резолвит по
 * (walletId, txHash, logIndex).
 */
export function useUpsertAnnotationByKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      body: import("./api").AnnotationUpsertBody & {
        walletId: string;
        txHash: string;
        logIndex: number;
      },
    ) => chainOpsApi.annotations.upsertByKey(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.annotations() });
      qc.invalidateQueries({ queryKey: KEYS.graphInternalTransfers() });
    },
  });
}

export function useDeleteAnnotation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (opId: string) => chainOpsApi.annotations.delete(opId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.annotations() });
      qc.invalidateQueries({ queryKey: KEYS.graphInternalTransfers() });
    },
  });
}
