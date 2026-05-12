/**
 * Группировка чейнов по источнику данных — для UI-фильтров.
 *
 * - `evm`     — DeBank (eth, arb, op, base, polygon, bsc, avax, …)
 * - `sol`     — Helius (Solana)
 * - `coinstats` — CoinStats (sui, ton, aptos, cosmos, berachain, monad, …)
 *
 * Группа определяется по `wallet.chain` (а не по op.chain): кошельки
 * `chain === "evm"` могут давать ops с разных EVM-чейнов (eth/arb/base/…).
 */

import type { SavedWallet, WalletChain } from "./wallets";

export type ChainGroup = "evm" | "sol" | "coinstats";

export function chainGroupOfWallet(w: SavedWallet): ChainGroup {
  return chainGroupOfWalletChain(w.chain);
}

export function chainGroupOfWalletChain(chain: WalletChain): ChainGroup {
  if (chain === "sol") return "sol";
  if (chain === "coinstats") return "coinstats";
  return "evm";
}

export const CHAIN_GROUP_LABEL: Record<ChainGroup, string> = {
  evm: "EVM",
  sol: "Solana",
  coinstats: "CoinStats",
};
