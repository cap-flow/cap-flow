/**
 * Alchemy eth_getLogs fallback for V3 liquidity events (port of web
 * `lib/v3/liquidity_events.ts`), used when Etherscan free tier doesn't support
 * the chain (e.g. Optimism Velodrome). viem `getLogs` over the full range works
 * on the admin PAYG Alchemy key; block timestamps are attached via getBlock
 * (the getLogs result carries no blockTime, which the DefiLlama pricing needs).
 */
import { parseAbiItem, type Address, type PublicClient } from "viem";

import type { V3LiquidityEvent } from "@cap-flow/ucb/v3_types";

const INCREASE_LIQUIDITY_EVENT = parseAbiItem(
  "event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
);
const DECREASE_LIQUIDITY_EVENT = parseAbiItem(
  "event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
);

function mapLog(
  log: { blockNumber: bigint; transactionHash: string; args: unknown },
  type: "increase" | "decrease",
  tokenId: bigint,
): V3LiquidityEvent {
  const a = log.args as { liquidity?: bigint; amount0?: bigint; amount1?: bigint };
  return {
    type,
    tokenId,
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
    liquidity: a.liquidity ?? 0n,
    amount0Raw: a.amount0 ?? 0n,
    amount1Raw: a.amount1 ?? 0n,
  };
}

/** Resolve unix timestamps for a set of blocks via getBlock (deduped). */
async function attachBlockTimes(
  client: PublicClient,
  events: V3LiquidityEvent[],
): Promise<void> {
  const unique = [...new Set(events.map((e) => e.blockNumber))];
  const tsByBlock = new Map<bigint, number>();
  await Promise.all(
    unique.map(async (bn) => {
      try {
        const block = await client.getBlock({ blockNumber: bn });
        tsByBlock.set(bn, Number(block.timestamp));
      } catch {
        /* skip — event stays without blockTime */
      }
    }),
  );
  for (const e of events) {
    const ts = tsByBlock.get(e.blockNumber);
    if (ts != null) e.blockTime = ts;
  }
}

/** All IncreaseLiquidity/DecreaseLiquidity events for one NFT via viem getLogs. */
export async function fetchV3EventsViem(
  client: PublicClient,
  npm: string,
  tokenId: bigint,
): Promise<{ increases: V3LiquidityEvent[]; decreases: V3LiquidityEvent[] }> {
  const address = npm as Address;
  const [incRaw, decRaw] = await Promise.all([
    client.getLogs({
      address,
      event: INCREASE_LIQUIDITY_EVENT,
      args: { tokenId },
      fromBlock: "earliest",
      toBlock: "latest",
    }),
    client.getLogs({
      address,
      event: DECREASE_LIQUIDITY_EVENT,
      args: { tokenId },
      fromBlock: "earliest",
      toBlock: "latest",
    }),
  ]);
  const increases = incRaw.map((l) => mapLog(l, "increase", tokenId));
  const decreases = decRaw.map((l) => mapLog(l, "decrease", tokenId));
  await attachBlockTimes(client, [...increases, ...decreases]);
  return { increases, decreases };
}
