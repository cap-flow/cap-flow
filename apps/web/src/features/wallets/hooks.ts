import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  walletsApi,
  type AddAddressInput,
  type CreateWalletInput,
} from "./api";

const KEYS = {
  list: (accountId: string) => ["wallets", "list", accountId] as const,
  addresses: (accountId: string, walletId: string) =>
    ["wallets", "addresses", accountId, walletId] as const,
};

export function useWallets(accountId: string | null) {
  return useQuery({
    queryKey: accountId
      ? KEYS.list(accountId)
      : ["wallets", "list", "none"],
    queryFn: () => walletsApi.list(accountId!),
    enabled: !!accountId,
    staleTime: 30_000,
  });
}

export function useCreateWallet(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWalletInput) =>
      walletsApi.create(accountId, input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: KEYS.list(accountId) }),
  });
}

export function useRenameWallet(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ walletId, name }: { walletId: string; name: string }) =>
      walletsApi.rename(accountId, walletId, name),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: KEYS.list(accountId) }),
  });
}

export function useDeleteWallet(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (walletId: string) => walletsApi.delete(accountId, walletId),
    onSuccess: (_res, walletId) => {
      // Optimistically drop the wallet from the cached list IMMEDIATELY so the
      // localStorage hydration (useWalletsHydration) rebuilds in lockstep and
      // LoadedWalletsProvider prunes it from positions/registry without a page
      // reload. Previously we only invalidated → the async refetch lag left the
      // deleted wallet visible until a manual cache clear.
      qc.setQueryData<{ id: string }[]>(KEYS.list(accountId), (old) =>
        old ? old.filter((w) => w.id !== walletId) : old,
      );
      qc.removeQueries({ queryKey: KEYS.addresses(accountId, walletId) });
      void qc.invalidateQueries({ queryKey: KEYS.list(accountId) });
    },
  });
}

export function useWalletAddresses(
  accountId: string,
  walletId: string | null
) {
  return useQuery({
    queryKey: walletId
      ? KEYS.addresses(accountId, walletId)
      : ["wallets", "addresses", accountId, "none"],
    queryFn: () => walletsApi.listAddresses(accountId, walletId!),
    enabled: !!walletId,
    staleTime: 30_000,
  });
}

export function useAddAddress(accountId: string, walletId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AddAddressInput) =>
      walletsApi.addAddress(accountId, walletId, input),
    onSuccess: () =>
      qc.invalidateQueries({
        queryKey: KEYS.addresses(accountId, walletId),
      }),
  });
}

export function useDeleteAddress(accountId: string, walletId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (addressId: string) =>
      walletsApi.deleteAddress(accountId, walletId, addressId),
    onSuccess: () =>
      qc.invalidateQueries({
        queryKey: KEYS.addresses(accountId, walletId),
      }),
  });
}
