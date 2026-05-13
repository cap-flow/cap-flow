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
 * Merge policy (post-SaaS): localStorage is a **mirror** of the API,
 * not its own source. On each hydration we **rewrite the entire list**
 * from API data (`api:<wid>:<aid>` ids). Legacy non-`api:` entries are
 * dropped as orphan — they predate the SaaS pivot and there's no path
 * to bring them back into the API ownership chain without the user
 * re-adding them explicitly. Keeping them caused Alice's Реестр to
 * show 4 wallets when DB had 3 (and similar mismatches when an
 * impersonation cycle leaked a previous admin's entry).
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

    // Server is the source of truth. Replace the entire list with
    // freshly-built api:<wid>:<aid> entries. Legacy non-api: entries
    // are dropped as orphans — they have no API counterpart, so the
    // dashboard can't refresh / classify them anyway. Keeping them
    // around caused phantom 4th wallet in Alice's Реестр when DB had 3.
    const merged = apiWallets;

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
