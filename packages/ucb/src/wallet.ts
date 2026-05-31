/**
 * Wallet identity types — shared UCB engine (A0). Moved from
 * `apps/web/src/lib/wallets.ts` (which keeps its React/localStorage store and
 * re-exports these). The engine's `BuildInput.wallet` / `OpenPosition`
 * reference `SavedWallet`, so the type must live where the engine does.
 */

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
