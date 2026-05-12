/**
 * Загрузка V3 LP-позиций кошелька через Alchemy RPC.
 *
 * Сценарий:
 *  1. NPM.balanceOf(wallet) → сколько NFT-позиций
 *  2. Σ tokenOfOwnerByIndex → tokenId[]
 *  3. positions(tokenId) → token0, token1, fee, tickLower, tickUpper, liquidity
 *  4. Активные (liquidity > 0): factory.getPool → pool.slot0() → currentTick
 *  5. ERC20.symbol/decimals для token0, token1
 *
 * Вся пачка идёт через viem multicall — обычно 2-3 round-trip'а на чейн.
 */

import {
  createPublicClient,
  http,
  type Address,
  type PublicClient,
} from "viem";

import { ERC20_ABI, FACTORY_ABI, NPM_ABI, POOL_ABI } from "./abis";
import { alchemyRpcUrl, type V3Deployment } from "./chains";
import {
  isInRange,
  rawToHuman,
  sqrtPriceX96ToPrice,
  tickToPrice,
  tickToSqrtPriceRaw,
  v3RawAmountsAt,
} from "./math";

export interface V3Position {
  /** id деплоя (uniswap-v3-arb / pancake-v3-bsc / ...). */
  deploymentId: string;
  /** Лейбл протокола (для UI). */
  protocolLabel: string;
  /** Чейн-код (eth/arb/op/...). */
  chain: string;
  /** NFT tokenId. */
  tokenId: bigint;
  /** Адрес пула. */
  poolAddress: Address;
  token0: { address: Address; symbol: string; decimals: number };
  token1: { address: Address; symbol: string; decimals: number };
  /** Fee tier пула (3000 = 0.3%). */
  feeTier: number;
  tickLower: number;
  tickUpper: number;
  /** Цена нижней границы (token1 за token0). */
  priceLower: number;
  /** Цена верхней границы. */
  priceUpper: number;
  /** Текущая цена пула. */
  currentPrice: number;
  /** Текущий tick пула. */
  currentTick: number;
  /** Liquidity NFT'а (raw uint128). */
  liquidity: bigint;
  /** В диапазоне ли currentTick. */
  inRange: boolean;
  /** Текущие amounts в human-единицах (после ребалансировки до currentPrice). */
  amount0Current: number;
  amount1Current: number;
  /** Amounts при выходе вниз (price = Pa): всё в token0. */
  amount0AtPa: number;
  amount1AtPa: number;
  /** Amounts при выходе вверх (price = Pb): всё в token1. */
  amount0AtPb: number;
  amount1AtPb: number;
}

function makeClient(dep: V3Deployment, apiKey: string): PublicClient {
  return createPublicClient({
    chain: dep.chain,
    transport: http(alchemyRpcUrl(dep, apiKey), {
      batch: true,
      // S3.5: cap_access cookie auths against backend upstream-proxy.
      fetchOptions: { credentials: "include" },
    }),
  });
}

/** Прочитать все V3-позиции одного кошелька в одном деплое (протокол × сеть). */
export async function fetchV3PositionsForDeployment(
  dep: V3Deployment,
  wallet: Address,
  apiKey: string,
): Promise<V3Position[]> {
  const client = makeClient(dep, apiKey);

  // 1) balanceOf
  const balance = (await client.readContract({
    address: dep.npm,
    abi: NPM_ABI,
    functionName: "balanceOf",
    args: [wallet],
  })) as bigint;

  if (balance === 0n) return [];

  // 2) все tokenId через multicall
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

  if (tokenIds.length === 0) return [];

  // 3) positions(tokenId) для всех
  const posCalls = tokenIds.map((id) => ({
    address: dep.npm,
    abi: NPM_ABI,
    functionName: "positions" as const,
    args: [id] as const,
  }));
  const posRes = await client.multicall({ contracts: posCalls, allowFailure: true });

  type RawPos = readonly [
    bigint, // nonce
    Address, // operator
    Address, // token0
    Address, // token1
    number, // fee
    number, // tickLower
    number, // tickUpper
    bigint, // liquidity
    bigint, // feeGrowthInside0LastX128
    bigint, // feeGrowthInside1LastX128
    bigint, // tokensOwed0
    bigint, // tokensOwed1
  ];

  interface Active {
    tokenId: bigint;
    token0: Address;
    token1: Address;
    fee: number;
    tickLower: number;
    tickUpper: number;
    liquidity: bigint;
  }

  const active: Active[] = [];
  for (let i = 0; i < posRes.length; i++) {
    const r = posRes[i];
    if (r.status !== "success") continue;
    const p = r.result as RawPos;
    if (p[7] === 0n) continue; // closed (liquidity = 0)
    active.push({
      tokenId: tokenIds[i],
      token0: p[2],
      token1: p[3],
      fee: p[4],
      tickLower: p[5],
      tickUpper: p[6],
      liquidity: p[7],
    });
  }
  if (active.length === 0) return [];

  // 4) factory.getPool + token decimals/symbol — параллельным multicall'ом.
  const tokens = new Set<Address>();
  for (const a of active) {
    tokens.add(a.token0);
    tokens.add(a.token1);
  }
  const tokenList = Array.from(tokens);

  const poolCalls = active.map((a) => ({
    address: dep.factory,
    abi: FACTORY_ABI,
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
    const d = decRes[i];
    const s = symRes[i];
    if (d.status === "success") decByToken.set(tokenList[i], Number(d.result));
    if (s.status === "success") symByToken.set(tokenList[i], s.result as string);
  }

  // 5) pool.slot0() для всех уникальных пулов
  const uniquePools = Array.from(
    new Set(
      poolByIdx.filter((p): p is Address => p != null && p !== "0x0000000000000000000000000000000000000000"),
    ),
  );
  const slotCalls = uniquePools.map((addr) => ({
    address: addr,
    abi: POOL_ABI,
    functionName: "slot0" as const,
  }));
  const slotRes = await client.multicall({ contracts: slotCalls, allowFailure: true });
  const slotByPool = new Map<Address, { sqrtPriceX96: bigint; tick: number }>();
  for (let i = 0; i < uniquePools.length; i++) {
    const r = slotRes[i];
    if (r.status !== "success") continue;
    const s = r.result as readonly [bigint, number, number, number, number, number, boolean];
    slotByPool.set(uniquePools[i], { sqrtPriceX96: s[0], tick: s[1] });
  }

  // Сборка
  const out: V3Position[] = [];
  for (let i = 0; i < active.length; i++) {
    const a = active[i];
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
    });
  }
  return out;
}
