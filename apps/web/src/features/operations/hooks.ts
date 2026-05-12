import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  operationsApi,
  type ImportItem,
  type OperationsListFilter,
} from "./api";

const KEYS = {
  list: (accountId: string, filter: OperationsListFilter) =>
    ["operations", "list", accountId, filter] as const,
  stats: (accountId: string) =>
    ["operations", "stats", accountId] as const,
};

export function useOperations(
  accountId: string | null,
  filter: OperationsListFilter = {}
) {
  return useQuery({
    queryKey: accountId
      ? KEYS.list(accountId, filter)
      : ["operations", "list", "none"],
    queryFn: () => operationsApi.list(accountId!, filter),
    enabled: !!accountId,
    staleTime: 30_000,
  });
}

export function useOperationStats(accountId: string | null) {
  return useQuery({
    queryKey: accountId
      ? KEYS.stats(accountId)
      : ["operations", "stats", "none"],
    queryFn: () => operationsApi.stats(accountId!),
    enabled: !!accountId,
    staleTime: 30_000,
  });
}

export function useImportOperations(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (items: ImportItem[]) =>
      operationsApi.import(accountId, items),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["operations", "list", accountId] });
      qc.invalidateQueries({ queryKey: KEYS.stats(accountId) });
    },
  });
}

export function useDeleteOperation(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (operationId: string) =>
      operationsApi.delete(accountId, operationId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["operations", "list", accountId] });
      qc.invalidateQueries({ queryKey: KEYS.stats(accountId) });
    },
  });
}
