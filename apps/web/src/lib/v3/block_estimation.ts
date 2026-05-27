/**
 * Estimate `blockNumber` at a given Unix timestamp.
 *
 * Используется когда нужно сузить `eth_getLogs` range для Alchemy free
 * tier (10 block per request) при наличии mint timestamp от Krystal.
 *
 * Не делает RPC вызов для конвертации — использует **per-chain average
 * block rate** + текущий block number. Погрешность 1-10 минут (10-300
 * блоков) для chain'ов с переменным block time. Это **специально**
 * аппроксимирует на безопасную сторону (subtract safety margin),
 * чтобы `fromBlock` не пропустил mint event.
 *
 * Если для chain'а нет известного rate — возвращает `null` → caller
 * не передаёт fromBlock → старое поведение (chunked from earliest или
 * full range).
 */
import { createPublicClient, http } from "viem";
import type { V3Deployment } from "./chains";
import { alchemyRpcUrl } from "./chains";

/** Средние block times по chain'ам (секунд per block). */
const CHAIN_BLOCK_SECONDS: Record<string, number> = {
  eth: 12,
  arb: 0.25,
  op: 2,
  base: 2,
  matic: 2,
  bsc: 3,
  avax: 2,
  ron: 3,
};

/**
 * Safety margin в блоках. Subtract от estimated, чтобы fromBlock
 * гарантированно <= actual mint block (избегаем потери mint event'а
 * из-за accumulated drift в block time).
 *
 * Per-chain — у chain'ов с быстрыми блоками margin должен быть
 * больше в блочном выражении (1 час BASE = 1800 блоков, vs 1 час
 * ETH = 300 блоков).
 */
const SAFETY_MARGIN_BLOCKS: Record<string, bigint> = {
  eth: 300n, // ~1 час
  arb: 14400n, // ~1 час
  op: 1800n,
  base: 1800n,
  matic: 1800n,
  bsc: 1200n,
  avax: 1800n,
  ron: 1200n,
};

const DEFAULT_SAFETY_MARGIN = 1800n;

/**
 * Получить current block number через Alchemy upstream-proxy.
 * Кешируем на 1 минуту чтобы не делать RPC call для каждого NFT.
 */
const blockNumberCache = new Map<string, { value: bigint; fetchedAt: number }>();
const CACHE_TTL_MS = 60_000;

export async function getCurrentBlockNumber(
  dep: V3Deployment,
  alchemyKey: string,
): Promise<bigint | null> {
  const key = dep.alchemySubdomain;
  const cached = blockNumberCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value;
  }
  try {
    const client = createPublicClient({
      chain: dep.chain,
      transport: http(alchemyRpcUrl(dep, alchemyKey), {
        fetchOptions: { credentials: "include" },
      }),
    });
    const bn = await client.getBlockNumber();
    blockNumberCache.set(key, { value: bn, fetchedAt: Date.now() });
    return bn;
  } catch {
    return null;
  }
}

/**
 * Estimate block number at given Unix timestamp.
 *
 * @param chainCode — debank chain code (eth/arb/base/...)
 * @param currentBlock — текущий block number
 * @param targetTimestampSec — Unix seconds момента который ищем
 * @param now — Date.now() / 1000, при тестировании можно передавать фиксированное
 */
export function estimateBlockAtTimestamp(args: {
  chainCode: string;
  currentBlock: bigint;
  targetTimestampSec: number;
  nowSec?: number;
}): bigint | null {
  const blockSecs = CHAIN_BLOCK_SECONDS[args.chainCode.toLowerCase()];
  if (!blockSecs || blockSecs <= 0) return null;
  const nowSec = args.nowSec ?? Math.floor(Date.now() / 1000);
  if (args.targetTimestampSec <= 0 || args.targetTimestampSec >= nowSec) {
    return null;
  }
  const secondsAgo = nowSec - args.targetTimestampSec;
  const blocksAgo = BigInt(Math.floor(secondsAgo / blockSecs));
  const margin = SAFETY_MARGIN_BLOCKS[args.chainCode.toLowerCase()] ?? DEFAULT_SAFETY_MARGIN;
  const estimated = args.currentBlock - blocksAgo - margin;
  return estimated > 0n ? estimated : 1n;
}
