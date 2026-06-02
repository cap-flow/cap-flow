/**
 * B3-full L2d — server V3 enrichment source. Produces `v3PositionMap` +
 * `v3CostBasis` (the inputs `applyV3CostBasisOverride` consumes) for non-Krystal
 * V3 LP — the server analogue of the client's `useV3Positions` +
 * `useV3LiquidityEvents` hooks. Pipeline per (wallet, deployment):
 *   1. fetch on-chain positions (wallet-owned + gauge-staked) → V3Position[]
 *      → keyed into v3PositionMap exactly as the client (v3PositionKey).
 *   2. per NFT: Etherscan IncreaseLiquidity/DecreaseLiquidity events.
 *   3. per event: pool slot0 price at block-1 (+ USD anchor) → deriveUsdPrices,
 *      with a batched DefiLlama fallback for volatile/volatile pairs.
 *   4. computeV3CostBasis (shared pure aggregation) → v3CostBasis by tokenId.
 *
 * Fail-soft per target / per NFT. Krystal-covered V3 still gets its authoritative
 * startUsd from the later Krystal step; this fills the rest (Velodrome gauge, etc.).
 */
import type { Address, PublicClient } from "viem";

import { v3PositionKey } from "@cap-flow/ucb/v3_types";
import type { V3CostBasisResult, V3LiquidityEvent, V3Position } from "@cap-flow/ucb/v3_types";
import { computeV3CostBasis } from "@cap-flow/ucb/v3_cost_basis_compute";
import { deriveUsdPrices, type V3PoolPrice } from "@cap-flow/ucb/v3_pricing";
import { isStableSymbol } from "@cap-flow/ucb/protocols";

import { defillamaCoinKey, priceFromMap } from "../classifier/defillama_keys.js";
import {
  findV3Deployments,
  resolveV3DeploymentIds,
  type V3Deployment,
} from "./v3/deployments.js";
import { fetchAllV3Positions, makeV3Client } from "./v3/positions.fetch.js";
import { fetchPoolPriceAtBlock } from "./v3/pool-price.fetch.js";

/** Position shape needed to pick V3 deployments (OpenPosition-compatible). */
export interface V3TargetPosition {
  protocol: { name: string };
  chain: string;
  walletId: string;
}

/** Etherscan slice the source needs. */
export interface V3EventSource {
  fetchV3LiquidityEvents(
    chainCode: string,
    npm: string,
    tokenId: bigint,
    signal?: AbortSignal,
  ): Promise<{ increases: V3LiquidityEvent[]; decreases: V3LiquidityEvent[] }>;
}

export interface V3EnrichmentDeps {
  etherscan: V3EventSource;
  /** Admin Alchemy key (env). Absent → no-op (empty maps). */
  alchemyKey: string | undefined;
  fetchHistoricalPrices: (
    items: { coin: string; timestamp: number }[],
    signal?: AbortSignal,
  ) => Promise<Map<string, number>>;
  /** Injectable for tests; default to the real viem implementations. */
  makeClient?: (dep: V3Deployment, apiKey: string) => PublicClient;
  fetchPositions?: (
    dep: V3Deployment,
    wallet: Address,
    apiKey: string,
  ) => Promise<V3Position[]>;
  fetchPoolPrice?: (
    client: PublicClient,
    poolAddress: string,
    blockNumber: bigint,
    chainCode: string,
  ) => Promise<V3PoolPrice | null>;
}

export interface V3EnrichmentResult {
  v3PositionMap: Map<string, V3Position[]>;
  v3CostBasis: Map<string, V3CostBasisResult>;
}

const EMPTY: V3EnrichmentResult = {
  v3PositionMap: new Map(),
  v3CostBasis: new Map(),
};

interface Target {
  dep: V3Deployment;
  walletId: string;
  address: Address;
}

export class V3EnrichmentSource {
  constructor(private readonly deps: V3EnrichmentDeps) {}

  /** The override's injected deployment resolver (chain, protocol → ids). */
  resolveDeploymentIds(chainCode: string, protocolName: string): string[] {
    return resolveV3DeploymentIds(chainCode, protocolName);
  }

  async forPositions(
    positions: readonly V3TargetPosition[],
    walletAddressById: ReadonlyMap<string, string>,
    signal?: AbortSignal,
  ): Promise<V3EnrichmentResult> {
    const apiKey = this.deps.alchemyKey;
    if (!apiKey) return EMPTY;
    const makeClient = this.deps.makeClient ?? makeV3Client;
    const fetchPositions = this.deps.fetchPositions ?? fetchAllV3Positions;
    const fetchPoolPrice = this.deps.fetchPoolPrice ?? fetchPoolPriceAtBlock;

    // 1. Unique (deployment, wallet) targets.
    const targets = new Map<string, Target>();
    for (const p of positions) {
      const addr = walletAddressById.get(p.walletId);
      if (!addr) continue;
      for (const dep of findV3Deployments(p.chain, p.protocol.name)) {
        const k = `${dep.id}|${p.walletId}`;
        if (!targets.has(k)) {
          targets.set(k, { dep, walletId: p.walletId, address: addr as Address });
        }
      }
    }
    if (targets.size === 0) return EMPTY;

    // 2. Fetch positions per target → v3PositionMap.
    const v3PositionMap = new Map<string, V3Position[]>();
    const posByToken = new Map<string, { pos: V3Position; dep: V3Deployment }>();
    for (const t of targets.values()) {
      if (signal?.aborted) break;
      try {
        const fetched = await fetchPositions(t.dep, t.address, apiKey);
        for (const pos of fetched) {
          const key = v3PositionKey({
            walletId: t.walletId,
            chain: t.dep.chainCode,
            deploymentId: t.dep.id,
            symbols: [pos.token0.symbol, pos.token1.symbol],
          });
          const arr = v3PositionMap.get(key) ?? [];
          arr.push(pos);
          v3PositionMap.set(key, arr);
          posByToken.set(pos.tokenId.toString(), { pos, dep: t.dep });
        }
      } catch {
        /* fail-soft per target */
      }
    }
    if (posByToken.size === 0) return { v3PositionMap, v3CostBasis: new Map() };

    // 3. Events per NFT (Etherscan; throttled for the shared free-tier key).
    const eventsByToken = new Map<
      string,
      { increases: V3LiquidityEvent[]; decreases: V3LiquidityEvent[] }
    >();
    for (const [tokenIdStr, { pos, dep }] of posByToken) {
      if (signal?.aborted) break;
      try {
        const ev = await this.deps.etherscan.fetchV3LiquidityEvents(
          pos.chain,
          dep.npm,
          pos.tokenId,
          signal,
        );
        eventsByToken.set(tokenIdStr, ev);
      } catch {
        /* fail-soft per NFT — leave it without cost basis */
      }
    }

    // 4a. Pool slot0 prices per unique (chain, pool, block). One viem client per chain.
    const clientByChain = new Map<string, PublicClient>();
    const depByChain = new Map<string, V3Deployment>();
    for (const { pos, dep } of posByToken.values()) {
      if (!depByChain.has(pos.chain)) depByChain.set(pos.chain, dep);
    }
    const clientFor = (chain: string): PublicClient | null => {
      let c = clientByChain.get(chain);
      if (c) return c;
      const dep = depByChain.get(chain);
      if (!dep) return null;
      c = makeClient(dep, apiKey);
      clientByChain.set(chain, c);
      return c;
    };

    const poolPriceByKey = new Map<string, V3PoolPrice | null>();
    for (const [tokenIdStr, ev] of eventsByToken) {
      const entry = posByToken.get(tokenIdStr);
      if (!entry) continue;
      const { pos } = entry;
      for (const e of [...ev.increases, ...ev.decreases]) {
        const pk = `${pos.chain}|${pos.poolAddress.toLowerCase()}|${e.blockNumber}`;
        if (poolPriceByKey.has(pk)) continue;
        const client = clientFor(pos.chain);
        if (!client) {
          poolPriceByKey.set(pk, null);
          continue;
        }
        try {
          poolPriceByKey.set(
            pk,
            await fetchPoolPrice(client, pos.poolAddress, e.blockNumber, pos.chain),
          );
        } catch {
          poolPriceByKey.set(pk, null);
        }
      }
    }

    // 4b. DefiLlama batch for volatile/volatile pairs (neither side a stable).
    const llamaNeeds: { coin: string; timestamp: number }[] = [];
    const seen = new Set<string>();
    for (const [tokenIdStr, ev] of eventsByToken) {
      const entry = posByToken.get(tokenIdStr);
      if (!entry) continue;
      const { pos } = entry;
      if (isStableSymbol(pos.token0.symbol) || isStableSymbol(pos.token1.symbol)) continue;
      const c0 = defillamaCoinKey(pos.chain, pos.token0.address, pos.token0.symbol);
      const c1 = defillamaCoinKey(pos.chain, pos.token1.address, pos.token1.symbol);
      if (!c0 || !c1) continue;
      for (const e of [...ev.increases, ...ev.decreases]) {
        if (!e.blockTime) continue;
        for (const coin of [c0, c1]) {
          const k = `${coin}|${e.blockTime}`;
          if (seen.has(k)) continue;
          seen.add(k);
          llamaNeeds.push({ coin, timestamp: e.blockTime });
        }
      }
    }
    let llamaPrices = new Map<string, number>();
    if (llamaNeeds.length > 0) {
      try {
        llamaPrices = await this.deps.fetchHistoricalPrices(llamaNeeds, signal);
      } catch {
        /* fail-soft — volatile pairs just stay unpriced */
      }
    }

    // 5. Cost basis per NFT via the shared pure aggregation.
    const v3CostBasis = new Map<string, V3CostBasisResult>();
    for (const [tokenIdStr, ev] of eventsByToken) {
      const entry = posByToken.get(tokenIdStr);
      if (!entry) continue;
      const { pos } = entry;
      const priceForEvent = (e: V3LiquidityEvent) => {
        const pk = `${pos.chain}|${pos.poolAddress.toLowerCase()}|${e.blockNumber}`;
        const pp = poolPriceByKey.get(pk) ?? undefined;
        return deriveUsdPrices(
          pos.token0,
          pos.token1,
          pp ?? undefined,
          e.blockTime,
          (address, symbol, blockTime) => {
            const coin = defillamaCoinKey(pos.chain, address, symbol);
            return coin ? priceFromMap(llamaPrices, coin, blockTime) : null;
          },
        );
      };
      const cb = computeV3CostBasis(pos, ev.increases, ev.decreases, priceForEvent);
      if (ev.increases.length > 0 || ev.decreases.length > 0) {
        v3CostBasis.set(tokenIdStr, cb);
      }
    }

    return { v3PositionMap, v3CostBasis };
  }
}
