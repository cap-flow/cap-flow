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

import { fetchMintedNftTokenIds } from "../nonlp/alchemy_transfers";
import {
  ERC20_ABI,
  FACTORY_ABI,
  NPM_ABI,
  POOL_ABI,
  VELODROME_FACTORY_ABI,
  VELODROME_POOL_ABI,
} from "./abis";
import { alchemyRpcUrl, type V3Deployment } from "./chains";
import {
  isInRange,
  rawToHuman,
  sqrtPriceX96ToPrice,
  tickToPrice,
  tickToSqrtPriceRaw,
  v3RawAmountsAt,
} from "./math";

// V3Position shape moved to @cap-flow/ucb/v3_types (B3-full layer 1) so the pure
// override + the client/server fetch share one type; re-exported for import sites.
// (viem `Address` === `0x${string}` === the package's HexAddress.)
export type { V3Position } from "@cap-flow/ucb/v3_types";
import type { V3Position } from "@cap-flow/ucb/v3_types";

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

  return assembleV3Positions(client, dep, tokenIds);
}

/**
 * Сборка `V3Position[]` из набора tokenId. Общий путь для wallet-owned
 * discovery (`fetchV3PositionsForDeployment`) и gauge-staked discovery
 * (`fetchV3StakedPositions`): делает positions()/getPool/slot0 multicall'ы,
 * фильтрует liquidity>0, считает текущие amounts.
 */
async function assembleV3Positions(
  client: ReturnType<typeof makeClient>,
  dep: V3Deployment,
  tokenIds: bigint[],
): Promise<V3Position[]> {
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
    /** Raw uncollected fees snapshot from NPM positions() last 2 fields. */
    tokensOwed0Raw: bigint;
    tokensOwed1Raw: bigint;
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
      // p[8] = feeGrowthInside0LastX128, p[9] = feeGrowthInside1LastX128 —
      // больше не нужны (Krystal делает real-time accrual server-side).
      tokensOwed0Raw: p[10],
      tokensOwed1Raw: p[11],
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

  // Velodrome/Aerodrome Slipstream: getPool(...,int24 tickSpacing) — другой
  // селектор, иначе reverts (Uniswap ABI). `a.fee` = tickSpacing для CL.
  const factoryAbi = /velodrome|aerodrome/i.test(dep.id)
    ? VELODROME_FACTORY_ABI
    : FACTORY_ABI;
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
    const d = decRes[i];
    const s = symRes[i];
    if (d.status === "success") decByToken.set(tokenList[i], Number(d.result));
    if (s.status === "success") symByToken.set(tokenList[i], s.result as string);
  }

  // 5) pool.slot0() для всех уникальных пулов — нужен только sqrtPriceX96 + tick.
  //
  // Pre-PR-CLEANUP: дополнительно фетчили pool.feeGrowthGlobal0/1X128 +
  // pool.ticks(tickLower/Upper) для real-time fee accrual (Uniswap §6.3 math).
  // Убрано: Krystal Cloud делает это server-side (default global ON через
  // capflow.feature.krystalV3Primary). Экономит +1 multicall round-trip
  // per page load + ~316 LOC math/tests (fee_growth.ts).
  const uniquePools = Array.from(
    new Set(
      poolByIdx.filter((p): p is Address => p != null && p !== "0x0000000000000000000000000000000000000000"),
    ),
  );
  // Velodrome/Aerodrome Slipstream pool slot0 без feeProtocol (6 полей).
  const poolAbi = /velodrome|aerodrome/i.test(dep.id)
    ? VELODROME_POOL_ABI
    : POOL_ABI;
  const slotCalls = uniquePools.map((addr) => ({
    address: addr,
    abi: poolAbi,
    functionName: "slot0" as const,
  }));

  const slotRes = await client.multicall({ contracts: slotCalls, allowFailure: true });

  const slotByPool = new Map<Address, { sqrtPriceX96: bigint; tick: number }>();
  for (let i = 0; i < uniquePools.length; i++) {
    const r = slotRes[i];
    if (r.status === "success") {
      // sqrtPriceX96 + tick — первые два поля в обоих layout'ах (Uniswap 7 / Velodrome 6).
      const s = r.result as readonly [bigint, number, ...unknown[]];
      slotByPool.set(uniquePools[i], { sqrtPriceX96: s[0], tick: s[1] });
    }
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

    // tokensOwed snapshot from NPM positions() — обновляется только при
    // collect/decreaseLiquidity. Real-time accrual идёт через Krystal Cloud
    // (PR-K3, server-side §6.3 math). Без Krystal pendingFee = snapshot.
    const tokensOwed0 = Number(a.tokensOwed0Raw) / 10 ** dec0;
    const tokensOwed1 = Number(a.tokensOwed1Raw) / 10 ** dec1;
    const pendingFee0 = tokensOwed0;
    const pendingFee1 = tokensOwed1;
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
      // PR-1b: use real-time computed pendingFee (tokensOwed + feeGrowth accrual),
      // NOT raw tokensOwed snapshot. Pre-fix typo cost ≥5 deploy iterations debugging
      // because verbose console.log read updated `pendingFee0` correctly but push
      // hardcoded `tokensOwed0`. ALWAYS verify property values vs local vars.
      pendingFee0,
      pendingFee1,
    });
  }
  return out;
}

/**
 * Gauge-staked V3 позиции (Velodrome/Aerodrome CL Slipstream).
 *
 * После stake'а NFT принадлежит CLGauge, поэтому `balanceOf(wallet)=0` и
 * `fetchV3PositionsForDeployment` её не находит. Здесь:
 *   1. enumerate'им все NFT данного NPM, **сминченные** на кошелёк
 *      (mint-событие 0x0 → wallet остаётся в истории даже после stake'а);
 *   2. `ownerOf(tokenId)` — оставляем те, что больше НЕ у кошелька
 *      (= застейканы в gauge либо переведены); burned (revert) отсекаются;
 *   3. собираем через общий `assembleV3Positions` (он сам фильтрует
 *      liquidity>0 — закрытые/выведенные позиции отпадают).
 *
 * Результат вливается в тот же V3PositionMap → существующий events→override
 * путь (`useV3LiquidityEvents` + `applyV3CostBasisOverride`) считает honest
 * cost basis из IncreaseLiquidity. Никакой новой override-логики не нужно.
 */
export async function fetchV3StakedPositions(
  dep: V3Deployment,
  wallet: Address,
  apiKey: string,
): Promise<V3Position[]> {
  const minted = await fetchMintedNftTokenIds(dep.chainCode, dep.npm, wallet);
  if (minted.length === 0) return [];

  const client = makeClient(dep, apiKey);

  // ownerOf для всех сминченных — оставляем НЕ-у-кошелька (staked в gauge).
  const ownerCalls = minted.map((id) => ({
    address: dep.npm,
    abi: NPM_ABI,
    functionName: "ownerOf" as const,
    args: [id] as const,
  }));
  const ownerRes = await client.multicall({
    contracts: ownerCalls,
    allowFailure: true,
  });
  const walletLc = wallet.toLowerCase();
  const stakedIds: bigint[] = [];
  for (let i = 0; i < ownerRes.length; i++) {
    const r = ownerRes[i];
    if (r.status !== "success") continue; // burned → ownerOf reverts
    const owner = (r.result as Address).toLowerCase();
    if (owner === walletLc) continue; // ещё у кошелька → покрыто обычным path
    stakedIds.push(minted[i]);
  }
  return assembleV3Positions(client, dep, stakedIds);
}
