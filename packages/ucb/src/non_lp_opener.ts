/**
 * Non-LP opener — shared pure types + key helper (UCB engine).
 *
 * Moved verbatim from web (`lib/nonlp/cost_basis.ts` OpenedInToken,
 * `lib/nonlp/opener_detector.ts` NonLpOpener, `lib/nonlp/use_opener_detector.ts`
 * keyOf/nonLpOpenerKey) so BOTH the client and the server can apply the non-LP
 * opener override via `apply_opener_override.ts`. The Etherscan/Alchemy FETCH
 * that produces a `NonLpOpener` stays client-side (web hook) / server-side
 * (B4 fetch service) — only the data shapes + the stable key live here.
 */

/** A token spent at position open (OUT-side of the deposit tx). */
export interface OpenedInToken {
  /** Token contract address (lowercase). */
  address: string;
  symbol: string;
  /** Human-units amount (decimal-shifted). */
  amount: number;
}

export interface NonLpOpener {
  /** Unix seconds — block time of the first receipt IN transfer. */
  openedAt: number;
  /** Block number of the deposit tx (Stage 2 on-chain price lookup). */
  openBlock: number;
  /** Tx hash of the opening transaction. */
  txHash: string;
  /** Human-units amount of receipt token in the first IN transfer. */
  receiptAmount: number;
  /**
   * Stage 2: OUT-side — tokens SPENT at open (transfers from the same opener tx
   * where from==wallet). Empty if OUT is not in the opener tx (Safe-internal).
   */
  openedInTokens: OpenedInToken[];
  /**
   * Stage 2a: startUsd when the OUT-side is all USD-stables (Σ × $1); null when
   * OUT is empty OR contains a non-stable (needs Stage 2b historical price).
   * ALREADY multiplied by `receiptNetFraction` (cost basis of the REMAINING
   * position share).
   */
  startUsd: number | null;
  /**
   * Stage 2d (partial withdrawal): the receipt-token share REMAINING in the
   * position = `(Σ receipt IN − Σ receipt OUT) / Σ receipt IN`. 1 = nothing
   * withdrawn; 0 = fully exited. Applied to startUsd (stable + volatile).
   */
  receiptNetFraction?: number;
}

/** Stable composite key for an opener: `chain|receiptToken|wallet` (lowercased). */
export function keyOf(t: {
  chainCode: string;
  receiptToken: string;
  wallet: string;
}): string {
  return `${t.chainCode.toLowerCase()}|${t.receiptToken.toLowerCase()}|${t.wallet.toLowerCase()}`;
}

/** Build the opener key from positional args (matches `apply_opener_override`). */
export function nonLpOpenerKey(
  chainCode: string,
  receiptToken: string,
  wallet: string,
): string {
  return keyOf({ chainCode, receiptToken, wallet });
}
