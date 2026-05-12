/**
 * Точная USD-цена депозита V3 LP через `pool.slot0()` на mint-блоке.
 *
 * DefiLlama даёт цены с **часовой** гранулярностью (агрегат через многие
 * DEX/CEX). Это ~$5-15/ETH ошибка при сравнении с тем что V3 пул реально
 * использовал в момент mint'а.
 *
 * V3 пул даёт **точную** цену в момент mint'а через `slot0().sqrtPriceX96`.
 * Эта цена использовалась самим контрактом для расчёта `amount0` и `amount1`
 * из выбранной liquidity и [tickLower, tickUpper].
 *
 * Алгоритм:
 *   1. `eth_getTransactionReceipt(mintTxHash)` → blockNumber
 *   2. `eth_call(pool.slot0, blockTag = blockNumber)` → sqrtPriceX96
 *   3. Конвертация: `price1Per0 = (sqrtPriceX96 / 2^96)^2 × 10^(dec0 - dec1)`
 *   4. Если token1 — стейбл (USDC/USDT/DAI), то price1Per0 = USD-цена token0.
 *      Иначе нужна внешняя цена одного из токенов (DefiLlama).
 *
 * Кэш в localStorage по ключу `${chain}|${pool}|${blockNumber}` —
 * исторические цены неизменны → infinite TTL.
 */

import {
  createPublicClient,
  http,
  type Address,
  type PublicClient,
} from "viem";

import { POOL_ABI, ERC20_ABI } from "./abis";
import { alchemyRpcUrl, V3_DEPLOYMENTS, type V3Deployment } from "./chains";

const CACHE_KEY = "capflow.cache.v3pool.v3";

/** Pool.Mint event topic0 = keccak256("Mint(address,address,int24,int24,uint128,uint256,uint256)") */
const MINT_EVENT_TOPIC0 =
  "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde";

interface CachedPoolMintPrice {
  /** WETH-USDC pool на момент mint: USDC за 1 WETH (или token1 за token0). */
  price1Per0: number;
  /** Адреса token0/token1 для проверки. */
  token0: string;
  token1: string;
  /** Decimals — для пересчёта вне модуля. */
  decimals0: number;
  decimals1: number;
  blockNumber: number;
  /**
   * ТОЧНЫЕ atomic amounts из Pool.Mint event (uint256 → string чтобы пережить
   * JSON serialization без потери точности). Декодируются в human-units по
   * decimals0/decimals1 в потребителе. Это устраняет drift от DeBank rounding'а
   * (m.amount там уже округлён до 6-8 знаков, а реальный transfer atomic).
   */
  exactAmount0?: string;
  exactAmount1?: string;
  /**
   * Опциональный USD-якорь для volatile/volatile pool'ов: цена ETH (или
   * другого major-токена пары) в USD на блоке mint'а, прочитанная через
   * slot0() ещё одного pool'а (WETH/USDC) на той же сети и том же блоке.
   *
   * Если пул сам содержит стейбл — anchor не нужен (price1Per0 даёт USD
   * сразу). Для WETH/ARB и подобных — anchor избавляет от DefiLlama
   * hourly-bucket дрифта (~$10-30 на $14k позиции).
   *
   * Поле:
   *   anchorTokenAddress — адрес "не-стейблового" токена в anchor pool
   *     (обычно WETH), case-insensitive
   *   anchorTokenUsd     — USD-цена этого токена на блоке mint'а
   */
  anchorTokenAddress?: string;
  anchorTokenUsd?: number;
}

/**
 * USD-якорь pool'ы по сетям. Берём самый ликвидный V3 pool с одной
 * стороной = USDC (или USDT), чтобы slot0() дал точный oracle.
 *
 * Адреса проверены по Uniswap V3 / PancakeSwap V3 deployments.
 */
const USD_ANCHOR_POOLS: Record<
  string,
  {
    pool: `0x${string}`;
    /** Какой токен в pool — стейбл (USDC/USDT) — token0 или token1. */
    stableSide: 0 | 1;
    stableDecimals: number;
    /** Не-стейбловый токен (WETH/WMATIC/WBNB). */
    otherDecimals: number;
    /** Symbol of the anchor token (для UI debug). */
    otherSymbol: string;
    /** Known address of the non-stable token in this pool (lowercase). */
    otherAddress: string;
  }
> = {
  // arb: Uniswap V3 WETH/USDC 0.05% (token0=WETH, token1=USDC native)
  arb: {
    pool: "0xC6962004f452bE9203591991D15f6b388e09E8D0",
    stableSide: 1,
    stableDecimals: 6,
    otherDecimals: 18,
    otherSymbol: "WETH",
    otherAddress: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
  },
  // eth: Uniswap V3 WETH/USDC 0.05% (token0=USDC, token1=WETH)
  eth: {
    pool: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
    stableSide: 0,
    stableDecimals: 6,
    otherDecimals: 18,
    otherSymbol: "WETH",
    otherAddress: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  },
  // op: Uniswap V3 WETH/USDC.e 0.05% (token0=WETH, token1=USDC.e)
  op: {
    pool: "0x85149247691df622eaF1a8Bd0CaFd40BC45154a9",
    stableSide: 1,
    stableDecimals: 6,
    otherDecimals: 18,
    otherSymbol: "WETH",
    otherAddress: "0x4200000000000000000000000000000000000006",
  },
  // base: Uniswap V3 WETH/USDC 0.05% (token0=WETH, token1=USDC)
  base: {
    pool: "0xd0b53D9277642d899DF5C87A3966A349A798F224",
    stableSide: 1,
    stableDecimals: 6,
    otherDecimals: 18,
    otherSymbol: "WETH",
    otherAddress: "0x4200000000000000000000000000000000000006",
  },
  // matic: Uniswap V3 WMATIC/USDC 0.05% (token0=WMATIC, token1=USDC)
  matic: {
    pool: "0xA374094527e1673A86dE625aa59517c5dE346d32",
    stableSide: 1,
    stableDecimals: 6,
    otherDecimals: 18,
    otherSymbol: "WMATIC",
    otherAddress: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
  },
};

type Cache = Record<string, CachedPoolMintPrice>;

function readCache(): Cache {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Cache;
  } catch {
    return {};
  }
}

function writeCache(c: Cache): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    /* quota — игнорируем */
  }
}

function cacheKey(chainCode: string, pool: string, blockNumber: number): string {
  return `${chainCode}|${pool.toLowerCase()}|${blockNumber}`;
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

/**
 * Конвертация sqrtPriceX96 (V3 формат) в человекочитаемую цену
 * **token1 за 1 token0**, с поправкой на decimals.
 *
 *   raw_price = (sqrtPriceX96 / 2^96)^2  // raw atomic units
 *   price1Per0 = raw_price × 10^decimals0 / 10^decimals1
 *
 * Используем BigInt для безопасности при больших значениях, потом float
 * для финального деления.
 */
export function sqrtPriceX96ToPrice1Per0(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
): number {
  // (sqrtP / 2^96)^2 = sqrtP^2 / 2^192
  // Чтобы избежать переполнения JS Number, делим в BigInt и потом конвертируем.
  const Q96 = 1n << 96n;
  // sqrtP^2 — может быть очень большим. Для float-конверсии берём отношение
  // как Number с потерей точности (это OK для USD цен с 4-знач. точностью).
  const numerator = sqrtPriceX96 * sqrtPriceX96;
  const denominator = Q96 * Q96;
  const raw = Number(numerator) / Number(denominator);
  return raw * Math.pow(10, decimals0 - decimals1);
}

export interface FetchPoolMintPriceArgs {
  chainCode: string;
  poolAddress: string;
  txHash: string;
  alchemyApiKey: string;
}

/**
 * Берёт цену пула на блоке mint'а. Сначала смотрит в localStorage кэш по
 * (chain, pool, blockNumber). Если не найдено — делает 3 RPC-вызова:
 *   1. eth_getTransactionReceipt — узнаём блок
 *   2. pool.token0() / pool.token1() / decimals — для расшифровки sqrtPrice
 *   3. pool.slot0() с blockTag=blockNumber — sqrtPriceX96
 *
 * Возвращает price1Per0 (token1 amount per 1 token0) + меta.
 */
export async function fetchPoolMintPrice(
  args: FetchPoolMintPriceArgs,
): Promise<CachedPoolMintPrice | null> {
  // Найти deployment для chainCode (нужен chain config + alchemy subdomain).
  const dep = V3_DEPLOYMENTS.find((d) => d.chainCode === args.chainCode);
  if (!dep) return null;

  const client = makeClient(dep, args.alchemyApiKey);

  // 1. Получить receipt → blockNumber + Pool.Mint event с ТОЧНЫМИ amount0/amount1.
  let blockNumber: bigint;
  let exactAmount0: string | undefined;
  let exactAmount1: string | undefined;
  try {
    const receipt = await client.getTransactionReceipt({
      hash: args.txHash as `0x${string}`,
    });
    blockNumber = receipt.blockNumber;
    // Ищем Pool.Mint event эмиттированный КОНКРЕТНО нашим pool'ом.
    // В тx'е может быть несколько Mint event'ов (multicall), но нам нужен
    // тот, чей log.address == args.poolAddress.
    const targetPool = args.poolAddress.toLowerCase();
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== targetPool) continue;
      if (log.topics[0]?.toLowerCase() !== MINT_EVENT_TOPIC0) continue;
      // data layout (4×32 bytes): sender, amount(liquidity), amount0, amount1
      const data = log.data.startsWith("0x") ? log.data.slice(2) : log.data;
      if (data.length < 64 * 4) continue;
      // amount0 в bytes 64-95 (offset 0x40 = 128 hex chars), amount1 в 96-127.
      const a0Hex = data.slice(64 * 2, 64 * 3);
      const a1Hex = data.slice(64 * 3, 64 * 4);
      exactAmount0 = BigInt("0x" + a0Hex).toString();
      exactAmount1 = BigInt("0x" + a1Hex).toString();
      break; // первый Mint от нашего пула — это наш mint
    }
  } catch (e) {
    console.warn(
      `[V3 hist price] tx receipt fetch failed ${args.txHash}:`,
      (e as Error).message,
    );
    return null;
  }

  // Кэш-проверка.
  const cache = readCache();
  const cKey = cacheKey(args.chainCode, args.poolAddress, Number(blockNumber));
  if (cache[cKey]) return cache[cKey]!;

  // 2. Прочитать token0, token1, decimals (на текущем блоке — они immutable).
  const pool = args.poolAddress as Address;
  let token0: Address;
  let token1: Address;
  try {
    [token0, token1] = (await Promise.all([
      client.readContract({
        address: pool,
        abi: [
          {
            type: "function" as const,
            name: "token0",
            stateMutability: "view" as const,
            inputs: [] as const,
            outputs: [{ name: "", type: "address" as const }] as const,
          },
        ],
        functionName: "token0",
      }),
      client.readContract({
        address: pool,
        abi: [
          {
            type: "function" as const,
            name: "token1",
            stateMutability: "view" as const,
            inputs: [] as const,
            outputs: [{ name: "", type: "address" as const }] as const,
          },
        ],
        functionName: "token1",
      }),
    ])) as [Address, Address];
  } catch (e) {
    console.warn(
      `[V3 hist price] token0/1 fetch failed pool ${pool}:`,
      (e as Error).message,
    );
    return null;
  }

  // 3. Decimals.
  let decimals0: number;
  let decimals1: number;
  try {
    [decimals0, decimals1] = (await Promise.all([
      client.readContract({
        address: token0,
        abi: ERC20_ABI,
        functionName: "decimals",
      }),
      client.readContract({
        address: token1,
        abi: ERC20_ABI,
        functionName: "decimals",
      }),
    ])) as [number, number];
  } catch (e) {
    console.warn(
      `[V3 hist price] decimals fetch failed:`,
      (e as Error).message,
    );
    return null;
  }

  // 4. slot0 на блоке mint'а (archive read через Alchemy).
  //
  // КРИТИЧНО: читаем на `blockNumber - 1` (state END предыдущего блока =
  // state START блока с mint'ом, ДО любых tx внутри блока). Mint сам не
  // меняет sqrtPrice (только Swap его двигает), поэтому pre-block slot0
  // === at-mint slot0 если только в нашем блоке не было swap'ов ПЕРЕД
  // нашим mint'ом. Read at `blockNumber` (end of block) даёт post-block
  // state, который уже включает все swap'ы блока (баг POS-001 Alex
  // 2026-05-08: $13 drift из-за слабых swap'ов после mint'а).
  const readBlock = blockNumber - 1n;
  let sqrtPriceX96: bigint;
  try {
    const slot0 = (await client.readContract({
      address: pool,
      abi: POOL_ABI,
      functionName: "slot0",
      blockNumber: readBlock,
    })) as readonly [bigint, number, number, number, number, number, boolean];
    sqrtPriceX96 = slot0[0];
  } catch (e) {
    console.warn(
      `[V3 hist price] slot0 at block ${readBlock} fetch failed:`,
      (e as Error).message,
    );
    return null;
  }

  const price1Per0 = sqrtPriceX96ToPrice1Per0(sqrtPriceX96, decimals0, decimals1);

  // 5. Если pool — volatile/volatile (нет стейбла среди token0/token1),
  //    получаем USD-якорь через slot0() ЕЩЁ ОДНОГО pool'а (WETH/USDC) на
  //    том же блоке. Это даёт точную WETH-USD цену "на момент mint'а"
  //    байт-в-байт совпадающую с тем, что использовал контракт. Без этого
  //    DefiLlama hourly bucket даёт ~0.2-0.5% drift на $14k позиции.
  let anchorTokenAddress: string | undefined;
  let anchorTokenUsd: number | undefined;
  const anchor = USD_ANCHOR_POOLS[args.chainCode];
  // ВСЕГДА выставляем `anchorTokenAddress` если для chain известен
  // wrapped-native (WETH/WMATIC/...) — даже если anchor pool fetch не нужен
  // (pool сам содержит стейбл). Это нужно buildV3Details для symbol-
  // фоллбека при native ETH в movement (DeBank даёт `0xeeeeeeee...` для
  // native — не совпадает с pool's WETH addr).
  if (anchor) {
    anchorTokenAddress = anchor.otherAddress.toLowerCase();
  }
  if (anchor && anchor.pool.toLowerCase() !== pool.toLowerCase()) {
    try {
      const anchorSlot0 = (await client.readContract({
        address: anchor.pool,
        abi: POOL_ABI,
        functionName: "slot0",
        blockNumber: readBlock,
      })) as readonly [bigint, number, number, number, number, number, boolean];
      const anchorSqrtP = anchorSlot0[0];
      const anchorD0 =
        anchor.stableSide === 0 ? anchor.stableDecimals : anchor.otherDecimals;
      const anchorD1 =
        anchor.stableSide === 1 ? anchor.stableDecimals : anchor.otherDecimals;
      const anchorPrice1Per0 = sqrtPriceX96ToPrice1Per0(
        anchorSqrtP,
        anchorD0,
        anchorD1,
      );
      // Если стейбл = token1 → anchor token = token0, цена = price1Per0
      // (USDC за 1 WETH = WETH-USD).
      // Если стейбл = token0 → anchor token = token1, цена = 1/price1Per0.
      anchorTokenUsd =
        anchor.stableSide === 1 ? anchorPrice1Per0 : 1 / anchorPrice1Per0;
    } catch (e) {
      console.warn(
        `[V3 hist price] USD anchor fetch failed for chain=${args.chainCode}:`,
        (e as Error).message,
      );
    }
  }

  const result: CachedPoolMintPrice = {
    price1Per0,
    token0,
    token1,
    decimals0,
    decimals1,
    blockNumber: Number(blockNumber),
    anchorTokenAddress,
    anchorTokenUsd,
    exactAmount0,
    exactAmount1,
  };

  cache[cKey] = result;
  writeCache(cache);

  return result;
}

/**
 * Bulk вариант: для списка mints одновременно дёргает все pool prices.
 * Используем `Promise.allSettled` чтобы один failure не ронял все.
 *
 * Возвращает Map по `${chain}|${txHash}` → CachedPoolMintPrice.
 */
export async function fetchPoolMintPrices(
  requests: FetchPoolMintPriceArgs[],
  signal?: AbortSignal,
): Promise<Map<string, CachedPoolMintPrice>> {
  const out = new Map<string, CachedPoolMintPrice>();
  const results = await Promise.allSettled(
    requests.map(async (r) => {
      if (signal?.aborted) return null;
      const res = await fetchPoolMintPrice(r);
      if (res) {
        out.set(`${r.chainCode}|${r.txHash.toLowerCase()}`, res);
      }
      return res;
    }),
  );
  // Логируем failures но не throw.
  for (const r of results) {
    if (r.status === "rejected") {
      console.warn("[V3 hist price] request rejected:", r.reason);
    }
  }
  return out;
}
