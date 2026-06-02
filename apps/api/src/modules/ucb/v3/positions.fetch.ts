/**
 * Server V3 position reads (port of web `lib/v3/positions.ts`) via viem +
 * the direct Alchemy admin endpoint. Produces `V3Position[]` for a wallet in one
 * deployment: NPM.balanceOf/tokenOfOwnerByIndex (wallet-owned) OR
 * alchemy_getAssetTransfers erc721 mint discovery + ownerOf (gauge-staked), then
 * positions()/factory.getPool/pool.slot0/ERC20 multicall → current amounts.
 */
import {
  createPublicClient,
  http,
  type Address,
  type PublicClient,
} from "viem";

import type { V3Position } from "@cap-flow/ucb/v3_types";
import {
  isInRange,
  rawToHuman,
  sqrtPriceX96ToPrice,
  tickToPrice,
  tickToSqrtPriceRaw,
  v3RawAmountsAt,
} from "@cap-flow/ucb/v3_math";

import {
  ERC20_ABI,
  FACTORY_ABI,
  NPM_ABI,
  POOL_ABI,
  VELODROME_FACTORY_ABI,
  VELODROME_POOL_ABI,
} from "./abis.js";
import {
  alchemyRpcUrl,
  isGaugeBasedDeployment,
  type V3Deployment,
} from "./deployments.js";

const ZERO_POOL = "0x0000000000000000000000000000000000000000";

export function makeV3Client(dep: V3Deployment, apiKey: string): PublicClient {
  return createPublicClient({
    chain: dep.chain,
    transport: http(alchemyRpcUrl(dep, apiKey), { batch: true }),
  });
}

interface RawNftTransfer {
  erc721TokenId?: string | null;
  tokenId?: string | null;
}

/**
 * tokenIds of all ERC721 NFTs of `dep.npm` RECEIVED by the wallet (any transfer
 * to=wallet, incl. mint 0x0→wallet). Needed for gauge-staked positions where the
 * NFT now belongs to the gauge so balanceOf(wallet)=0. Uses alchemy_getAssetTransfers
 * (no block-range limit).
 */
export async function fetchMintedNftTokenIds(
  client: PublicClient,
  npm: Address,
  wallet: Address,
): Promise<bigint[]> {
  // Alchemy enhanced RPC method — outside viem's typed method union, so call the
  // transport request untyped.
  const rpc = client.request as unknown as (args: {
    method: string;
    params: unknown[];
  }) => Promise<unknown>;
  const result = (await rpc({
    method: "alchemy_getAssetTransfers",
    params: [
      {
        fromBlock: "0x0",
        toBlock: "latest",
        category: ["erc721"],
        contractAddresses: [npm],
        toAddress: wallet,
        order: "asc",
        maxCount: "0x3e8",
      },
    ],
  })) as { transfers?: RawNftTransfer[] };
  const ids: bigint[] = [];
  const seen = new Set<string>();
  for (const t of result?.transfers ?? []) {
    const raw = t.erc721TokenId ?? t.tokenId;
    if (!raw) continue;
    try {
      const id = BigInt(raw);
      const key = id.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      ids.push(id);
    } catch {
      /* skip non-numeric tokenId */
    }
  }
  return ids;
}

/** All wallet-owned V3 positions in one deployment. */
export async function fetchV3PositionsForDeployment(
  dep: V3Deployment,
  wallet: Address,
  apiKey: string,
): Promise<V3Position[]> {
  const client = makeV3Client(dep, apiKey);
  const balance = (await client.readContract({
    address: dep.npm,
    abi: NPM_ABI,
    functionName: "balanceOf",
    args: [wallet],
  })) as bigint;
  if (balance === 0n) return [];

  const idCalls = Array.from({ length: Number(balance) }, (_, i) => ({
    address: dep.npm,
    abi: NPM_ABI,
    functionName: "tokenOfOwnerByIndex" as const,
    args: [wallet, BigInt(i)] as const,
  }));
  const idsRes = await client.multicall({ contracts: idCalls, allowFailure: true });
  const tokenIds: bigint[] = [];
  for (const r of idsRes) {
    if (r.status === "success") tokenIds.push(r.result as bigint);
  }
  return assembleV3Positions(client, dep, tokenIds);
}

/** Gauge-staked V3 positions (Velodrome/Aerodrome CL): mint discovery + ownerOf. */
export async function fetchV3StakedPositions(
  dep: V3Deployment,
  wallet: Address,
  apiKey: string,
): Promise<V3Position[]> {
  const client = makeV3Client(dep, apiKey);
  const minted = await fetchMintedNftTokenIds(client, dep.npm, wallet);
  if (minted.length === 0) return [];

  const ownerCalls = minted.map((id) => ({
    address: dep.npm,
    abi: NPM_ABI,
    functionName: "ownerOf" as const,
    args: [id] as const,
  }));
  const ownerRes = await client.multicall({ contracts: ownerCalls, allowFailure: true });
  const walletLc = wallet.toLowerCase();
  const stakedIds: bigint[] = [];
  for (let i = 0; i < ownerRes.length; i++) {
    const r = ownerRes[i]!;
    if (r.status !== "success") continue; // burned → ownerOf reverts
    const owner = (r.result as Address).toLowerCase();
    if (owner === walletLc) continue; // still wallet-owned → normal path covers it
    stakedIds.push(minted[i]!);
  }
  return assembleV3Positions(client, dep, stakedIds);
}

/** Both wallet-owned and (for gauge deployments) staked positions. */
export async function fetchAllV3Positions(
  dep: V3Deployment,
  wallet: Address,
  apiKey: string,
): Promise<V3Position[]> {
  const owned = await fetchV3PositionsForDeployment(dep, wallet, apiKey);
  if (!isGaugeBasedDeployment(dep)) return owned;
  const staked = await fetchV3StakedPositions(dep, wallet, apiKey);
  // Dedupe by tokenId (a position could appear in both paths in edge cases).
  const byId = new Map<string, V3Position>();
  for (const p of [...owned, ...staked]) byId.set(p.tokenId.toString(), p);
  return Array.from(byId.values());
}

type RawPos = readonly [
  bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint,
];

/** Shared assembly: positions()/getPool/slot0/ERC20 multicall → V3Position[]. */
async function assembleV3Positions(
  client: PublicClient,
  dep: V3Deployment,
  tokenIds: bigint[],
): Promise<V3Position[]> {
  if (tokenIds.length === 0) return [];

  const posCalls = tokenIds.map((id) => ({
    address: dep.npm,
    abi: NPM_ABI,
    functionName: "positions" as const,
    args: [id] as const,
  }));
  const posRes = await client.multicall({ contracts: posCalls, allowFailure: true });

  interface Active {
    tokenId: bigint;
    token0: Address;
    token1: Address;
    fee: number;
    tickLower: number;
    tickUpper: number;
    liquidity: bigint;
    tokensOwed0Raw: bigint;
    tokensOwed1Raw: bigint;
  }
  const active: Active[] = [];
  for (let i = 0; i < posRes.length; i++) {
    const r = posRes[i]!;
    if (r.status !== "success") continue;
    const p = r.result as RawPos;
    if (p[7] === 0n) continue; // closed (liquidity = 0)
    active.push({
      tokenId: tokenIds[i]!,
      token0: p[2],
      token1: p[3],
      fee: p[4],
      tickLower: p[5],
      tickUpper: p[6],
      liquidity: p[7],
      tokensOwed0Raw: p[10],
      tokensOwed1Raw: p[11],
    });
  }
  if (active.length === 0) return [];

  const tokens = new Set<Address>();
  for (const a of active) {
    tokens.add(a.token0);
    tokens.add(a.token1);
  }
  const tokenList = Array.from(tokens);

  const gauge = isGaugeBasedDeployment(dep);
  const factoryAbi = gauge ? VELODROME_FACTORY_ABI : FACTORY_ABI;
  const poolAbi = gauge ? VELODROME_POOL_ABI : POOL_ABI;

  const poolCalls = active.map((a) => ({
    address: dep.factory,
    abi: factoryAbi,
    functionName: "getPool" as const,
    args: [a.token0, a.token1, a.fee] as const,
  }));
  const decCalls = tokenList.map((addr) => ({
    address: addr,
    abi: ERC20_ABI,
    functionName: "decimals" as const,
  }));
  const symCalls = tokenList.map((addr) => ({
    address: addr,
    abi: ERC20_ABI,
    functionName: "symbol" as const,
  }));

  const [poolRes, decRes, symRes] = await Promise.all([
    client.multicall({ contracts: poolCalls, allowFailure: true }),
    client.multicall({ contracts: decCalls, allowFailure: true }),
    client.multicall({ contracts: symCalls, allowFailure: true }),
  ]);

  const poolByIdx: (Address | null)[] = poolRes.map((r) =>
    r.status === "success" ? (r.result as Address) : null,
  );
  const decByToken = new Map<Address, number>();
  const symByToken = new Map<Address, string>();
  for (let i = 0; i < tokenList.length; i++) {
    const d = decRes[i]!;
    const s = symRes[i]!;
    if (d.status === "success") decByToken.set(tokenList[i]!, Number(d.result));
    if (s.status === "success") symByToken.set(tokenList[i]!, s.result as string);
  }

  const uniquePools = Array.from(
    new Set(poolByIdx.filter((p): p is Address => p != null && p !== ZERO_POOL)),
  );
  const slotCalls = uniquePools.map((addr) => ({
    address: addr,
    abi: poolAbi,
    functionName: "slot0" as const,
  }));
  const slotRes = await client.multicall({ contracts: slotCalls, allowFailure: true });
  const slotByPool = new Map<Address, { sqrtPriceX96: bigint; tick: number }>();
  for (let i = 0; i < uniquePools.length; i++) {
    const r = slotRes[i]!;
    if (r.status === "success") {
      const s = r.result as readonly [bigint, number, ...unknown[]];
      slotByPool.set(uniquePools[i]!, { sqrtPriceX96: s[0], tick: s[1] });
    }
  }

  const out: V3Position[] = [];
  for (let i = 0; i < active.length; i++) {
    const a = active[i]!;
    const pool = poolByIdx[i];
    if (!pool) continue;
    const slot = slotByPool.get(pool);
    if (!slot) continue;
    const dec0 = decByToken.get(a.token0);
    const dec1 = decByToken.get(a.token1);
    const sym0 = symByToken.get(a.token0);
    const sym1 = symByToken.get(a.token1);
    if (dec0 == null || dec1 == null || !sym0 || !sym1) continue;

    const sqrtPa = tickToSqrtPriceRaw(a.tickLower);
    const sqrtPb = tickToSqrtPriceRaw(a.tickUpper);
    const sqrtP = tickToSqrtPriceRaw(slot.tick);
    const L = Number(a.liquidity);
    const cur = v3RawAmountsAt({ liquidityRaw: L, sqrtPa, sqrtPb, sqrtP });
    const atPa = v3RawAmountsAt({ liquidityRaw: L, sqrtPa, sqrtPb, sqrtP: sqrtPa });
    const atPb = v3RawAmountsAt({ liquidityRaw: L, sqrtPa, sqrtPb, sqrtP: sqrtPb });

    const tokensOwed0 = Number(a.tokensOwed0Raw) / 10 ** dec0;
    const tokensOwed1 = Number(a.tokensOwed1Raw) / 10 ** dec1;
    out.push({
      deploymentId: dep.id,
      protocolLabel: dep.label,
      chain: dep.chainCode,
      tokenId: a.tokenId,
      poolAddress: pool,
      token0: { address: a.token0, symbol: sym0, decimals: dec0 },
      token1: { address: a.token1, symbol: sym1, decimals: dec1 },
      feeTier: a.fee,
      tickLower: a.tickLower,
      tickUpper: a.tickUpper,
      priceLower: tickToPrice(a.tickLower, dec0, dec1),
      priceUpper: tickToPrice(a.tickUpper, dec0, dec1),
      currentPrice: sqrtPriceX96ToPrice(slot.sqrtPriceX96, dec0, dec1),
      currentTick: slot.tick,
      liquidity: a.liquidity,
      inRange: isInRange(slot.tick, a.tickLower, a.tickUpper),
      amount0Current: rawToHuman(cur.amount0, dec0),
      amount1Current: rawToHuman(cur.amount1, dec1),
      amount0AtPa: rawToHuman(atPa.amount0, dec0),
      amount1AtPa: rawToHuman(atPa.amount1, dec1),
      amount0AtPb: rawToHuman(atPb.amount0, dec0),
      amount1AtPb: rawToHuman(atPb.amount1, dec1),
      tokensOwed0,
      tokensOwed1,
      pendingFee0: tokensOwed0,
      pendingFee1: tokensOwed1,
    });
  }
  return out;
}
