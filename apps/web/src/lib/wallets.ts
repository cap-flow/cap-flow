import { useCallback } from "react";

import { useLocalStorage } from "./useLocalStorage";

/**
 * Тип кошелька — определяет как мы его загружаем:
 *   - "evm"       → DeBank как primary
 *   - "sol"       → Helius + Vybe + Sonar
 *   - "coinstats" → CoinStats для всех остальных сетей; сеть указана
 *                   в `connectionId` (e.g. "bitcoin", "ton-wallet").
 */
export type WalletChain = "evm" | "sol" | "coinstats";

export interface SavedWallet {
  id: string;
  name: string;
  address: string;
  chain: WalletChain;
  /**
   * Только для chain === "coinstats" — CoinStats `connectionId`
   * (см. lib/coinstats_chains.ts).
   */
  connectionId?: string;
  createdAt: number;
}

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
