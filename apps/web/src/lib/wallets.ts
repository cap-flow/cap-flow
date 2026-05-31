import { useCallback } from "react";

import { useLocalStorage } from "./useLocalStorage";

// A0: WalletChain / SavedWallet moved to `@cap-flow/ucb/wallet` (the engine
// references them). Re-exported here so existing `@/lib/wallets` import sites
// are unchanged; this file keeps the React/localStorage wallet store below.
import type { WalletChain, SavedWallet } from "@cap-flow/ucb/wallet";
export type { WalletChain, SavedWallet };

interface WalletsState {
  list: SavedWallet[];
  selectedId: string | null;
}

const DEFAULT: WalletsState = { list: [], selectedId: null };

function makeId(): string {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  );
}

export function useWallets() {
  const [state, setState] = useLocalStorage<WalletsState>(
    "capflow.wallets",
    DEFAULT,
  );

  const add = useCallback(
    (
      input: {
        name: string;
        address: string;
        chain?: WalletChain;
        connectionId?: string;
      },
    ): SavedWallet => {
      const wallet: SavedWallet = {
        id: makeId(),
        name: input.name.trim(),
        address: input.address.trim(),
        chain: input.chain ?? "evm",
        ...(input.connectionId && { connectionId: input.connectionId }),
        createdAt: Date.now(),
      };
      setState((s) => ({
        list: [...s.list, wallet],
        selectedId: wallet.id, // сразу делаем активным
      }));
      return wallet;
    },
    [setState],
  );

  const update = useCallback(
    (id: string, patch: Partial<Pick<SavedWallet, "name" | "address" | "chain">>) => {
      setState((s) => ({
        ...s,
        list: s.list.map((w) => (w.id === id ? { ...w, ...patch } : w)),
      }));
    },
    [setState],
  );

  const remove = useCallback(
    (id: string) => {
      setState((s) => ({
        list: s.list.filter((w) => w.id !== id),
        selectedId: s.selectedId === id ? null : s.selectedId,
      }));
    },
    [setState],
  );

  const select = useCallback(
    (id: string | null) => {
      setState((s) => ({ ...s, selectedId: id }));
    },
    [setState],
  );

  /** Replace the entire wallets state. Used by useWalletsHydration to sync
   *  the API-side wallets table into this localStorage-backed legacy store. */
  const replace = useCallback(
    (next: WalletsState) => {
      setState(next);
    },
    [setState],
  );

  const selected =
    state.list.find((w) => w.id === state.selectedId) ?? null;

  return {
    list: state.list,
    selectedId: state.selectedId,
    selected,
    state,
    add,
    update,
    remove,
    select,
    replace,
  };
}
