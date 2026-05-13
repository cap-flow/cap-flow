import { useEffect } from "react";
import { useQueries } from "@tanstack/react-query";

import { walletsApi, type WalletAddress } from "./api";
import { useWallets as useApiWallets } from "./hooks";
import { usePrimaryAccount } from "@/features/accounts/hooks";
import {
  useWallets,
  type SavedWallet,
  type WalletChain,
} from "@/lib/wallets";

/**
 * Bridges the legacy `localStorage.capflow.wallets` store (read by
 * LoadedWalletsProvider / HomePage dashboard) with the SaaS server
 * tables (`wallets`, `wallet_addresses`).
 *
 * Reactivity strategy: we deliberately share the **same query key** as
 * the rest of the wallets feature (`useApiWallets` from
 * `features/wallets/hooks`). That means any mutation that invalidates
 * `["wallets", "list", accountId]` — create, rename, delete — fires
 * this effect, so localStorage stays in lockstep with the API without
 * a page reload.
 *
 * Merge policy: every wallet sourced from the API is keyed `api:<wid>:<aid>`.
 * On each hydration we **drop all stale `api:`-prefixed entries** and
 * rewrite them from fresh API data. Local-only entries (legacy from
 * pre-SaaS) are preserved — those exit only via explicit user action
 * inside the legacy UI. This is the only way to make UI deletes
 * propagate back into the dashboard reliably.
 *
 * The bridge is one-way (server → local). New wallets created via the
 * SaaS `/wallets` page hit the API and then the hydration syncs them
 * to localStorage. Phase F6b will remove the legacy store entirely.
 */
export function useWalletsHydration(): void {
  const primary = usePrimaryAccount();
  const accountId = primary?.id;
  const { state, replace } = useWallets();

  // Sources the canonical SaaS-side wallet list. Same query key as
  // mutations (create/rename/delete) so this is invalidated by them.
  const walletsQ = useApiWallets(accountId ?? null);
  const wallets = walletsQ.data;

  // Per-wallet address lists, fetched in parallel.
  const addressesQs = useQueries({
    queries: (wallets ?? []).map((w) => ({
      queryKey: ["wallets", "addresses", accountId, w.id] as const,
      queryFn: () => walletsApi.listAddresses(accountId!, w.id),
      enabled: Boolean(accountId && w.id),
      staleTime: 30_000,
    })),
  });

  const allAddressesReady =
    !!wallets &&
    addressesQs.length === (wallets?.length ?? 0) &&
    addressesQs.every((q) => q.data !== undefined);

  useEffect(() => {
    if (!accountId || !wallets || !allAddressesReady) return;

    const apiWallets: SavedWallet[] = [];
    wallets.forEach((w, i) => {
      const addrs = addressesQs[i]?.data ?? [];
      for (const addr of addrs) {
        const chain = mapAddressTypeToChain(addr.type);
        if (!chain) continue;
        apiWallets.push({
          id: `api:${w.id}:${addr.id}`,
          name: w.name,
          address: addr.address,
          chain,
          createdAt: Date.parse(w.createdAt) || Date.now(),
        });
      }
    });

    // Drop every stale `api:`-prefixed entry, then append the fresh ones.
    // Local-only entries (no `api:` prefix) are pre-SaaS user additions
    // that the legacy UI still owns; we never touch them here.
    const localOnly = state.list.filter((w) => !w.id.startsWith("api:"));
    const merged = [...apiWallets, ...localOnly];

    if (sameList(state.list, merged)) return;

    const selectedId =
      state.selectedId && merged.some((w) => w.id === state.selectedId)
        ? state.selectedId
        : (merged[0]?.id ?? null);

    replace({ list: merged, selectedId });
  }, [
    accountId,
    wallets,
    addressesQs.map((q) => q.dataUpdatedAt).join(","),
    allAddressesReady,
    state.list,
    state.selectedId,
    replace,
  ]);
}

function mapAddressTypeToChain(t: WalletAddress["type"]): WalletChain | null {
  switch (t) {
    case "evm":
      return "evm";
    case "solana":
      return "sol";
    case "tron":
    case "btc":
    case "other":
      return null;
    default:
      return null;
  }
}

function sameList(a: SavedWallet[], b: SavedWallet[]): boolean {
  if (a.length !== b.length) return false;
  const ka = a.map((w) => `${w.id}|${w.address}|${w.chain}`).sort();
  const kb = b.map((w) => `${w.id}|${w.address}|${w.chain}`).sort();
  return ka.every((v, i) => v === kb[i]);
}
