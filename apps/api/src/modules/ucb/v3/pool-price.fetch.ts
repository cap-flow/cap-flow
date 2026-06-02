/**
 * Server V3 slot0 pricing (port of web `lib/v3/historical_pool_price.ts`). Reads
 * pool.slot0() at `blockNumber - 1` (pre-block state = at-mint price the contract
 * used) for a precise per-event USD oracle, plus a USD anchor pool (WETH/USDC) on
 * the same block for volatile/volatile pairs.
 *
 * Simpler than the client: the block number comes straight from the getLogs event
 * (no tx-receipt round-trip), and we read directly through the Alchemy admin
 * endpoint. Returns the pkg `V3PoolPrice` shape `deriveUsdPrices` consumes.
 * Velodrome Slipstream slot0 (6 fields) fails to decode under POOL_ABI → null →
 * the caller falls back to DefiLlama (same as the client).
 */
import type { Address, PublicClient } from "viem";

import type { V3PoolPrice } from "@cap-flow/ucb/v3_pricing";

import { ERC20_ABI, POOL_ABI } from "./abis.js";
import { USD_ANCHOR_POOLS } from "./deployments.js";

/** sqrtPriceX96 → human price token1 per token0 (decimal-adjusted). */
function sqrtPriceX96ToPrice1Per0(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
): number {
  const Q96 = 1n << 96n;
  const raw = Number(sqrtPriceX96 * sqrtPriceX96) / Number(Q96 * Q96);
  return raw * Math.pow(10, decimals0 - decimals1);
}

async function readSlot0SqrtP(
  client: PublicClient,
  pool: Address,
  blockNumber: bigint,
): Promise<bigint | null> {
  try {
    const slot0 = (await client.readContract({
      address: pool,
      abi: POOL_ABI,
      functionName: "slot0",
      blockNumber,
    })) as readonly [bigint, ...unknown[]];
    return slot0[0];
  } catch {
    return null; // Velodrome Slipstream (6 fields) or transient — caller → DefiLlama
  }
}

/**
 * Pool price (token1 per token0) at the event block, + a USD anchor for
 * volatile/volatile pairs. `null` when slot0 can't be read.
 */
export async function fetchPoolPriceAtBlock(
  client: PublicClient,
  poolAddress: string,
  eventBlockNumber: bigint,
  chainCode: string,
): Promise<V3PoolPrice | null> {
  const pool = poolAddress as Address;
  const readBlock = eventBlockNumber - 1n;

  let token0: Address;
  let token1: Address;
  try {
    [token0, token1] = (await Promise.all([
      client.readContract({ address: pool, abi: POOL_ABI, functionName: "token0" }),
      client.readContract({ address: pool, abi: POOL_ABI, functionName: "token1" }),
    ])) as [Address, Address];
  } catch {
    return null;
  }

  let decimals0: number;
  let decimals1: number;
  try {
    [decimals0, decimals1] = (await Promise.all([
      client.readContract({ address: token0, abi: ERC20_ABI, functionName: "decimals" }),
      client.readContract({ address: token1, abi: ERC20_ABI, functionName: "decimals" }),
    ])) as [number, number];
  } catch {
    return null;
  }

  const sqrtP = await readSlot0SqrtP(client, pool, readBlock);
  if (sqrtP == null) return null;
  const price1Per0 = sqrtPriceX96ToPrice1Per0(sqrtP, decimals0, decimals1);

  const out: V3PoolPrice = { price1Per0 };

  const anchor = USD_ANCHOR_POOLS[chainCode];
  if (anchor) {
    out.anchorTokenAddress = anchor.otherAddress.toLowerCase();
    if (anchor.pool.toLowerCase() !== pool.toLowerCase()) {
      const anchorSqrtP = await readSlot0SqrtP(client, anchor.pool, readBlock);
      if (anchorSqrtP != null) {
        const anchorD0 = anchor.stableSide === 0 ? anchor.stableDecimals : anchor.otherDecimals;
        const anchorD1 = anchor.stableSide === 1 ? anchor.stableDecimals : anchor.otherDecimals;
        const anchorPrice1Per0 = sqrtPriceX96ToPrice1Per0(anchorSqrtP, anchorD0, anchorD1);
        out.anchorTokenUsd =
          anchor.stableSide === 1 ? anchorPrice1Per0 : 1 / anchorPrice1Per0;
      }
    }
  }
  return out;
}
