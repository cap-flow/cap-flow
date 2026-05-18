/**
 * UCB C2 S1: detector для CEX A → on-chain → CEX B hop chains.
 *
 * Pure function over уже-связанных пар:
 *   - inbound: on-chain transfer_in matched к CEX withdrawal (D3 trail)
 *   - outbound: on-chain transfer_out matched к CEX deposit (C1 trail)
 *
 * Хоп цепь — это:
 *   1. Same wallet получает (inbound) и шлёт (outbound)
 *   2. Same token family (tokenFamily normalization, WETH≡ETH и т.д.)
 *   3. Outbound происходит ПОСЛЕ inbound (chronological)
 *   4. Окно ≤ 30 дней
 *
 * Greedy matching: для каждой inbound берём earliest outbound матчащий
 * критерии и помечаем оба used.
 *
 * Cost basis chain (semantic): CEX A withdrawal pool → wallet lot (D3
 * seeded) → wallet transfer_out → CEX B deposit (C1 seeded). C2
 * подтверждает что вся цепь существует и поверхностит её для UI/audit.
 */

import { tokenFamily } from "./internal-transfer-matcher.js";

const HOP_WINDOW_SEC = 30 * 24 * 60 * 60;

export interface CexHopInboundRow {
  /** Wallet, который получил on-chain. */
  readonly walletId: string;
  readonly chain: string;
  /** Tx hash on-chain (also matches CEX withdrawal tx_hash). */
  readonly txHash: string;
  readonly symbol: string;
  readonly amount: number;
  readonly timeSec: number;
  /** Source CEX из которого withdraw. */
  readonly cexAccountId: string;
  readonly cexExchange: string;
}

export interface CexHopOutboundRow {
  readonly walletId: string;
  readonly chain: string;
  readonly txHash: string;
  readonly symbol: string;
  readonly amount: number;
  readonly timeSec: number;
  /** Destination CEX в который deposit. */
  readonly cexAccountId: string;
  readonly cexExchange: string;
}

export interface CexHopChain {
  readonly walletId: string;
  readonly family: string;
  readonly fromCex: {
    readonly cexAccountId: string;
    readonly cexExchange: string;
  };
  readonly toCex: {
    readonly cexAccountId: string;
    readonly cexExchange: string;
  };
  readonly inboundTxHash: string;
  readonly outboundTxHash: string;
  readonly inboundChain: string;
  readonly outboundChain: string;
  readonly inboundAmount: number;
  readonly outboundAmount: number;
  readonly inboundTimeSec: number;
  readonly outboundTimeSec: number;
  /** outboundTime - inboundTime (always >= 0). */
  readonly durationSec: number;
}

export function detectCexHopChains(
  inbound: ReadonlyArray<CexHopInboundRow>,
  outbound: ReadonlyArray<CexHopOutboundRow>,
): CexHopChain[] {
  if (inbound.length === 0 || outbound.length === 0) return [];

  // Sort оба chronologically для greedy matching.
  const inSorted = [...inbound].sort((a, b) => a.timeSec - b.timeSec);
  const outSorted = [...outbound].sort((a, b) => a.timeSec - b.timeSec);

  const usedOutHashes = new Set<string>();
  const chains: CexHopChain[] = [];

  for (const inb of inSorted) {
    const inFamily = tokenFamily(inb.symbol);
    if (!inFamily) continue;
    const match = outSorted.find((o) => {
      if (usedOutHashes.has(o.txHash)) return false;
      if (o.walletId !== inb.walletId) return false;
      if (o.timeSec < inb.timeSec) return false;
      if (o.timeSec - inb.timeSec > HOP_WINDOW_SEC) return false;
      if (tokenFamily(o.symbol) !== inFamily) return false;
      return true;
    });
    if (!match) continue;
    usedOutHashes.add(match.txHash);
    chains.push({
      walletId: inb.walletId,
      family: inFamily,
      fromCex: {
        cexAccountId: inb.cexAccountId,
        cexExchange: inb.cexExchange,
      },
      toCex: {
        cexAccountId: match.cexAccountId,
        cexExchange: match.cexExchange,
      },
      inboundTxHash: inb.txHash,
      outboundTxHash: match.txHash,
      inboundChain: inb.chain,
      outboundChain: match.chain,
      inboundAmount: inb.amount,
      outboundAmount: match.amount,
      inboundTimeSec: inb.timeSec,
      outboundTimeSec: match.timeSec,
      durationSec: match.timeSec - inb.timeSec,
    });
  }
  return chains;
}
