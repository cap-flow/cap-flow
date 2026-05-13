import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { walletsApi, type WalletAddress } from "./api";
import { usePrimaryAccount } from "@/features/accounts/hooks";
import {
  useWallets,
  type SavedWallet,
  type WalletChain,
} from "@/lib/wallets";

/**
 * Bridges the legacy `localStorage.capflow.wallets` store (read by
 * LoadedWalletsProvider / HomePage dashboard) with the SaaS server
 * tables (`wallets`, `wallet_addresses`). Without this hook the dashboard
 * shows $0 immediately after login because localStorage is empty even
 * though the server has wallets + a populated snapshot.
 *
 * Strategy: on mount, fetch every API wallet of the primary account,
 * fan out into one SavedWallet per (wallet × address) pair, and merge
 * with the existing localStorage state. Server wins on duplicates
 * (matched by address+chain); local-only entries (created via legacy
 * code paths) are preserved.
 *
 * The bridge is intentionally one-way (server → local). Wallet creation
 * via the new /wallets page already writes to the API. The legacy
 * mutate-on-localStorage paths from the old SPA still write locally;
 * those entries stay until the dashboard is fully migrated to
 * server-sourced data (planned phase F6).
 */
export function useWalletsHydration(): void {
  const primary = usePrimaryAccount();
  const accountId = primary?.id;
  const { state, replace } = useWallets();

  const list = useQuery({
    queryKey: ["wallets", accountId, "hydration-list"],
    queryFn: async () => {
      if (!accountId) return [] as Array<{ wallet: { id: string; name: string; createdAt: string }; addresses: WalletAddress[] }>;
      const wallets = await walletsApi.list(accountId);
      const enriched = await Promise.all(
        wallets.map(async (w) => ({
          wallet: { id: w.id, name: w.name, createdAt: w.createdAt },
          addresses: await walletsApi.listAddresses(accountId, w.id),
        })),
      );
      return enriched;
    },
    enabled: Boolean(accountId),
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (!list.data) return;

    const apiWallets: SavedWallet[] = [];
    for (const { wallet, addresses } of list.data) {
      for (const addr of addresses) {
        const chain = mapAddressTypeToChain(addr.type);
        if (!chain) continue;
        apiWallets.push({
          id: `api:${wallet.id}:${addr.id}`,
          name: wallet.name,
          address: addr.address,
          chain,
          createdAt: Date.parse(wallet.createdAt) || Date.now(),
        });
      }
    }

    // Merge: API entries (keyed by `address|chain`) win; preserve local-only
    // entries (legacy, not in API yet).
    const keyOf = (w: SavedWallet) => `${w.address.toLowerCase()}|${w.chain}`;
    const apiKeys = new Set(apiWallets.map(keyOf));
    const localOnly = state.list.filter((w) => !apiKeys.has(keyOf(w)));
    const merged = [...apiWallets, ...localOnly];

    // No-op write if shape is already identical.
    if (sameList(state.list, merged)) return;

    const selectedId =
      state.selectedId && merged.some((w) => w.id === state.selectedId)
        ? state.selectedId
        : (merged[0]?.id ?? null);

    replace({ list: merged, selectedId });
  }, [list.data, state.list, state.selectedId, replace]);
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
      // Currently unsupported in the dashboard's live loader; skip.
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
