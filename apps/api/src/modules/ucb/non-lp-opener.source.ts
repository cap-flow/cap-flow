/**
 * B4 slice 2b — server source for the non-LP opener override inputs.
 *
 * Produces the `nonLpOpenerByKey` map that `applyNonLpOpenerOverride` consumes,
 * the server analogue of the client's `useNonLpOpenerDetector` hook. For every
 * non-V3-LP position with a receipt token (`lpTokenId`) it reads the wallet's raw
 * on-chain ERC20 transfer history (Etherscan primary, Alchemy fallback for
 * BASE/Avalanche), runs the SHARED pure resolvers
 * (`@cap-flow/ucb/non_lp_opener_resolve`), then prices any volatile OUT-side via
 * DefiLlama historical — identical logic to `opener_detector.ts`.
 *
 * Target selection MIRRORS the client (`use_computed_positions.ts`): skip
 * V3-LP (→ Krystal), require `lpTokenId` + an EVM wallet address, do NOT filter
 * by `openedAt` (the OUT-side cost basis is needed even for dated positions like
 * GMX V2 GLV). Grouped by (chain, wallet) so one fetch resolves all of a wallet's
 * receipt tokens. Fail-soft PER GROUP — a provider outage leaves that group out
 * of the map and the override stays a guarded no-op for those positions.
 */
import { isV3LpProtocol } from "@cap-flow/ucb/open_positions";
import { nonLpOpenerKey } from "@cap-flow/ucb/non_lp_opener";
import type { NonLpOpener } from "@cap-flow/ucb/non_lp_opener";
import {
  resolveOpenerBlocksFromAlchemy,
  resolveOpenersFromTransfers,
  type AlchemyTransfer,
  type WalletTransfer,
} from "@cap-flow/ucb/non_lp_opener_resolve";
import {
  isUsdStable,
  startUsdFromPricedOut,
  startUsdFromStableOut,
} from "@cap-flow/ucb/non_lp_cost_basis";

import {
  EtherscanChainNotSupportedError,
} from "../integrations/etherscan.js";
import {
  defillamaCoinKey,
  priceFromMap,
} from "../classifier/defillama_keys.js";

/** Minimal position shape needed to build opener targets (OpenPosition-compatible). */
export interface OpenerTargetPosition {
  protocol: { name: string };
  lpTokenId?: string | null;
  chain: string;
  walletId: string;
}

/** Etherscan slice the source needs. */
export interface EtherscanTransferSource {
  fetchWalletTokenTransfers(
    chainCode: string,
    wallet: string,
    signal?: AbortSignal,
  ): Promise<WalletTransfer[]>;
}

/** Alchemy slice the source needs (fallback for Etherscan-unsupported chains). */
export interface AlchemyTransferSource {
  fetchWalletTransfers(
    chainCode: string,
    wallet: string,
    signal?: AbortSignal,
  ): Promise<AlchemyTransfer[]>;
  fetchBlockTimestamps(
    chainCode: string,
    blockNumbers: readonly number[],
    signal?: AbortSignal,
  ): Promise<Map<number, number>>;
}

export interface NonLpOpenerDeps {
  etherscan: EtherscanTransferSource;
  /** Optional — when absent, Etherscan-unsupported chains are skipped. */
  alchemy?: AlchemyTransferSource;
  /** DefiLlama historical price fetch (structurally `fetchHistoricalPrices`). */
  fetchHistoricalPrices: (
    items: { coin: string; timestamp: number }[],
    signal?: AbortSignal,
  ) => Promise<Map<string, number>>;
  isAlchemyChainSupported?: (chainCode: string) => boolean;
}

interface OpenerGroup {
  chainCode: string;
  wallet: string;
  receiptTokens: string[];
}

export class NonLpOpenerSource {
  constructor(private readonly deps: NonLpOpenerDeps) {}

  /**
   * Build `nonLpOpenerByKey` for the given positions. Keys are
   * `nonLpOpenerKey(chain, lpTokenId, wallet)` (stable, not positionId).
   */
  async forPositions(
    positions: readonly OpenerTargetPosition[],
    walletAddressById: ReadonlyMap<string, string>,
    signal?: AbortSignal,
  ): Promise<Map<string, NonLpOpener>> {
    const groups = this.buildGroups(positions, walletAddressById);
    const result = new Map<string, NonLpOpener>();
    // Sequential per group — bounded fetch volume, mirrors the client's
    // per-(wallet,chain) batching. Fail-soft each.
    for (const g of groups.values()) {
      if (signal?.aborted) break;
      try {
        const openers = await this.resolveGroup(g, signal);
        for (const [rt, opener] of openers) {
          result.set(nonLpOpenerKey(g.chainCode, rt, g.wallet), opener);
        }
      } catch {
        /* fail-soft per group — leave it out of the map */
      }
    }
    return result;
  }

  /** Group non-V3-LP receipt tokens by (chain, wallet). */
  private buildGroups(
    positions: readonly OpenerTargetPosition[],
    walletAddressById: ReadonlyMap<string, string>,
  ): Map<string, OpenerGroup> {
    const groups = new Map<string, OpenerGroup>();
    for (const p of positions) {
      if (isV3LpProtocol(p.protocol.name)) continue;
      if (!p.lpTokenId) continue;
      const wallet = walletAddressById.get(p.walletId);
      if (!wallet) continue;
      const gk = `${p.chain.toLowerCase()}|${wallet.toLowerCase()}`;
      let g = groups.get(gk);
      if (!g) {
        g = { chainCode: p.chain, wallet, receiptTokens: [] };
        groups.set(gk, g);
      }
      const rt = p.lpTokenId.toLowerCase();
      if (!g.receiptTokens.includes(rt)) g.receiptTokens.push(rt);
    }
    return groups;
  }

  /** Etherscan primary, Alchemy fallback → openers (+ volatile startUsd). */
  private async resolveGroup(
    g: OpenerGroup,
    signal?: AbortSignal,
  ): Promise<Map<string, NonLpOpener>> {
    const openers = await this.resolveViaProvider(g, signal);
    await this.fillVolatileStartUsd(g.chainCode, openers, signal);
    return openers;
  }

  private async resolveViaProvider(
    g: OpenerGroup,
    signal?: AbortSignal,
  ): Promise<Map<string, NonLpOpener>> {
    try {
      const transfers = await this.deps.etherscan.fetchWalletTokenTransfers(
        g.chainCode,
        g.wallet,
        signal,
      );
      return resolveOpenersFromTransfers(transfers, g.receiptTokens, g.wallet);
    } catch (e) {
      if (!(e instanceof EtherscanChainNotSupportedError)) throw e;
      // Etherscan free does not support this chain → Alchemy fallback.
      const supported =
        this.deps.isAlchemyChainSupported?.(g.chainCode) ?? true;
      if (!this.deps.alchemy || !supported) throw e;
      const transfers = await this.deps.alchemy.fetchWalletTransfers(
        g.chainCode,
        g.wallet,
        signal,
      );
      const blocks = resolveOpenerBlocksFromAlchemy(
        transfers,
        g.receiptTokens,
        g.wallet,
      );
      if (blocks.size === 0) return new Map();
      const tsByBlock = await this.deps.alchemy.fetchBlockTimestamps(
        g.chainCode,
        Array.from(blocks.values()).map((b) => b.blockNumber),
        signal,
      );
      const out = new Map<string, NonLpOpener>();
      for (const [lp, b] of blocks) {
        const ts = tsByBlock.get(b.blockNumber);
        if (ts == null) continue;
        const grossStartUsd = startUsdFromStableOut(b.openedInTokens);
        out.set(lp, {
          openedAt: ts,
          openBlock: b.blockNumber,
          txHash: b.hash,
          receiptAmount: 0,
          openedInTokens: b.openedInTokens,
          startUsd:
            grossStartUsd != null
              ? grossStartUsd * b.receiptNetFraction
              : null,
          receiptNetFraction: b.receiptNetFraction,
        });
      }
      return out;
    }
  }

  /**
   * Stage 2b: openers with `startUsd == null` but a non-empty OUT-side have
   * volatile tokens — price each at deposit time via DefiLlama and recompute.
   * Mutates `op.startUsd` in place (objects just created → safe). Fail-soft.
   */
  private async fillVolatileStartUsd(
    chainCode: string,
    openers: Map<string, NonLpOpener>,
    signal?: AbortSignal,
  ): Promise<void> {
    const pending: NonLpOpener[] = [];
    const requests: { coin: string; timestamp: number }[] = [];
    const seen = new Set<string>();
    for (const op of openers.values()) {
      if (op.startUsd != null) continue;
      if (op.openedInTokens.length === 0) continue;
      pending.push(op);
      for (const t of op.openedInTokens) {
        if (isUsdStable(t.symbol)) continue;
        const coin = defillamaCoinKey(chainCode, t.address, t.symbol);
        if (!coin) continue;
        const key = `${coin}|${op.openedAt}`;
        if (seen.has(key)) continue;
        seen.add(key);
        requests.push({ coin, timestamp: op.openedAt });
      }
    }
    if (requests.length === 0) return;

    const priceMap = await this.deps.fetchHistoricalPrices(requests, signal);
    for (const op of pending) {
      const priceByAddress = new Map<string, number>();
      let allPriced = true;
      for (const t of op.openedInTokens) {
        if (isUsdStable(t.symbol)) continue;
        const coin = defillamaCoinKey(chainCode, t.address, t.symbol);
        const px = coin ? priceFromMap(priceMap, coin, op.openedAt) : null;
        if (px == null) {
          allPriced = false;
          break;
        }
        priceByAddress.set(t.address.toLowerCase(), px);
      }
      if (!allPriced) continue;
      const startUsd = startUsdFromPricedOut(op.openedInTokens, priceByAddress);
      if (startUsd != null) {
        op.startUsd = startUsd * (op.receiptNetFraction ?? 1);
      }
    }
  }
}
