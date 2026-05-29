/**
 * V3 NFT IncreaseLiquidity / DecreaseLiquidity events через Alchemy RPC.
 *
 * **Решает Проблему #2 из аудита**: DeBank не возвращает все
 * `increaseLiquidity` ops для V3 NFT. Например POS-001 XAUt/USDT
 * показывает live $162 но deposit history $57 (3× difference) — был
 * дополнительный increaseLiquidity, которого DeBank не показал.
 *
 * Стратегия: для каждой live V3 NFT-позиции через Alchemy запрашиваем
 * **все** IncreaseLiquidity events (filtered by tokenId), считаем
 * total deposited amount0/amount1, конвертируем в USD через histPrices,
 * сравниваем с DeBank-видимыми deposits → находим missing.
 *
 * Использование:
 *   const events = await fetchV3LiquidityEvents(dep, tokenId, alchemyKey);
 *   const totalDeposit0 = events.increases.reduce((s, e) => s + e.amount0Human, 0);
 *
 * Не используется в production paths сейчас (это доп. RPC calls).
 * Wire-up рекомендуется когда обнаружен mismatch DeBank vs live.
 */

import {
  createPublicClient,
  http,
  parseAbiItem,
  type Address,
  type PublicClient,
} from "viem";

import { alchemyRpcUrl, type V3Deployment } from "./chains";

export interface V3LiquidityEvent {
  /** "increase" — mint OR additional liquidity, "decrease" — partial/full burn. */
  type: "increase" | "decrease";
  /** NFT tokenId. */
  tokenId: bigint;
  /** Block number. */
  blockNumber: bigint;
  /** Block timestamp (unix sec). Заполняется отдельным запросом если нужно. */
  blockTime?: number;
  /** tx hash. */
  txHash: string;
  /** Liquidity delta (raw uint128). */
  liquidity: bigint;
  /** Raw amount0 (uint256, wei-scale token0 decimals). */
  amount0Raw: bigint;
  /** Raw amount1. */
  amount1Raw: bigint;
}

const INCREASE_LIQUIDITY_EVENT = parseAbiItem(
  "event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
);
const DECREASE_LIQUIDITY_EVENT = parseAbiItem(
  "event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
);

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
 * Запросить все IncreaseLiquidity и DecreaseLiquidity events для NFT.
 *
 * **Alchemy Free tier ограничивает `eth_getLogs` до 10 блоков**, поэтому
 * мы используем **chunked queries**: scan от `fromBlock` до `toBlock` чанками
 * по 10 блоков. ОЧЕНЬ медленно для миллионов блоков (10000 RPC × 100ms = 16 мин)
 * — поэтому обязательно указать узкий range через mint tx block.
 *
 * Стратегия:
 *   1. Если `fromBlock` НЕ задан — пробуем full range (сработает на PAYG plan)
 *   2. Free tier откажет с ошибкой 400 — подхватим chunked
 *   3. PAYG plan подхватит сразу (1 запрос вместо 1000+)
 */
export async function fetchV3LiquidityEvents(
  dep: V3Deployment,
  tokenId: bigint,
  apiKey: string,
  options?: {
    fromBlock?: bigint;
    toBlock?: bigint;
    /** Chunk size для free tier fallback. Default 10 (Alchemy free limit). */
    chunkSize?: bigint;
  },
): Promise<{
  increases: V3LiquidityEvent[];
  decreases: V3LiquidityEvent[];
}> {
  const client = makeClient(dep, apiKey);
  const npm = dep.npm as Address;

  // Step 1: try full range (works on PAYG, fails on free).
  try {
    const [increaseRaw, decreaseRaw] = await Promise.all([
      client.getLogs({
        address: npm,
        event: INCREASE_LIQUIDITY_EVENT,
        args: { tokenId },
        fromBlock: options?.fromBlock ?? "earliest",
        toBlock: options?.toBlock ?? "latest",
      }),
      client.getLogs({
        address: npm,
        event: DECREASE_LIQUIDITY_EVENT,
        args: { tokenId },
        fromBlock: options?.fromBlock ?? "earliest",
        toBlock: options?.toBlock ?? "latest",
      }),
    ]);
    return mapEvents(tokenId, increaseRaw, decreaseRaw);
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    // Detect Alchemy free tier limit error.
    if (!msg.includes("10 block range") && !msg.includes("PAYG")) {
      throw err;
    }
    // Fallback: chunked queries from fromBlock (or last 100K blocks if not given).
    if (typeof window !== "undefined") {
      console.warn(
        `[V3 logs chunked] Alchemy free tier — falling back к chunked queries для NFT ${tokenId}. ` +
          `Это медленно. Upgrade до Alchemy PAYG для 1-shot.`,
      );
    }
    return fetchV3LiquidityEventsChunked(client, npm, tokenId, options);
  }

  function mapEvents(
    tid: bigint,
    increaseRaw: Awaited<ReturnType<typeof client.getLogs>>,
    decreaseRaw: Awaited<ReturnType<typeof client.getLogs>>,
  ): { increases: V3LiquidityEvent[]; decreases: V3LiquidityEvent[] } {
    const increases: V3LiquidityEvent[] = increaseRaw.map((log) => ({
      type: "increase" as const,
      tokenId: tid,
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      liquidity: (log.args as any).liquidity!,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      amount0Raw: (log.args as any).amount0!,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      amount1Raw: (log.args as any).amount1!,
    }));
    const decreases: V3LiquidityEvent[] = decreaseRaw.map((log) => ({
      type: "decrease" as const,
      tokenId: tid,
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      liquidity: (log.args as any).liquidity!,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      amount0Raw: (log.args as any).amount0!,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      amount1Raw: (log.args as any).amount1!,
    }));
    return { increases, decreases };
  }
}

/**
 * Chunked fallback для free tier. Сканируем от `fromBlock` (default = mint
 * block через bin search) до latest по 10 блоков за раз.
 *
 * ВНИМАНИЕ: для NFT mint'нутого 100K блоков назад это ~10000 запросов
 * = много минут. Не запускайте без узкого range.
 */
async function fetchV3LiquidityEventsChunked(
  client: PublicClient,
  npm: Address,
  tokenId: bigint,
  options?: { fromBlock?: bigint; toBlock?: bigint; chunkSize?: bigint },
): Promise<{
  increases: V3LiquidityEvent[];
  decreases: V3LiquidityEvent[];
}> {
  const chunkSize = options?.chunkSize ?? 9n; // free tier limit
  const latestBlock =
    options?.toBlock ?? (await client.getBlockNumber());
  // Без fromBlock мы вынуждены пропустить — chunked-сканирование от earliest
  // возьмёт миллионы запросов. Возвращаем empty с warning.
  if (!options?.fromBlock) {
    if (typeof window !== "undefined") {
      console.warn(
        `[V3 logs chunked] no fromBlock for NFT ${tokenId} — skipping (chunked from earliest = miliony requests).`,
      );
    }
    return { increases: [], decreases: [] };
  }
  let from = options.fromBlock;
  const increases: V3LiquidityEvent[] = [];
  const decreases: V3LiquidityEvent[] = [];
  while (from <= latestBlock) {
    const to = from + chunkSize > latestBlock ? latestBlock : from + chunkSize;
    try {
      const [incRaw, decRaw] = await Promise.all([
        client.getLogs({
          address: npm,
          event: INCREASE_LIQUIDITY_EVENT,
          args: { tokenId },
          fromBlock: from,
          toBlock: to,
        }),
        client.getLogs({
          address: npm,
          event: DECREASE_LIQUIDITY_EVENT,
          args: { tokenId },
          fromBlock: from,
          toBlock: to,
        }),
      ]);
      for (const log of incRaw) {
        increases.push({
          type: "increase" as const,
          tokenId,
          blockNumber: log.blockNumber,
          txHash: log.transactionHash,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          liquidity: (log.args as any).liquidity!,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          amount0Raw: (log.args as any).amount0!,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          amount1Raw: (log.args as any).amount1!,
        });
      }
      for (const log of decRaw) {
        decreases.push({
          type: "decrease" as const,
          tokenId,
          blockNumber: log.blockNumber,
          txHash: log.transactionHash,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          liquidity: (log.args as any).liquidity!,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          amount0Raw: (log.args as any).amount0!,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          amount1Raw: (log.args as any).amount1!,
        });
      }
    } catch {
      /* skip chunk on error */
    }
    from = to + 1n;
  }
  return { increases, decreases };
}

/**
 * Total deposited amounts (across all IncreaseLiquidity events).
 * Возвращает в human-readable форме (после деления на 10^decimals).
 */
export function sumIncreaseAmounts(
  events: V3LiquidityEvent[],
  decimals0: number,
  decimals1: number,
): { totalAmount0: number; totalAmount1: number } {
  let raw0 = 0n;
  let raw1 = 0n;
  for (const e of events) {
    raw0 += e.amount0Raw;
    raw1 += e.amount1Raw;
  }
  const totalAmount0 = Number(raw0) / 10 ** decimals0;
  const totalAmount1 = Number(raw1) / 10 ** decimals1;
  return { totalAmount0, totalAmount1 };
}

/**
 * Дополнить events временами блоков. Полезно для historical price lookup.
 */
export async function attachBlockTimes(
  dep: V3Deployment,
  apiKey: string,
  events: V3LiquidityEvent[],
): Promise<V3LiquidityEvent[]> {
  if (events.length === 0) return events;
  const client = makeClient(dep, apiKey);
  const uniqueBlocks = [...new Set(events.map((e) => e.blockNumber))];
  const blockTimes = new Map<bigint, number>();
  await Promise.all(
    uniqueBlocks.map(async (blockNumber) => {
      try {
        const block = await client.getBlock({ blockNumber });
        blockTimes.set(blockNumber, Number(block.timestamp));
      } catch {
        /* skip */
      }
    }),
  );
  return events.map((e) => ({
    ...e,
    blockTime: blockTimes.get(e.blockNumber),
  }));
}

/**
 * A cached cost-basis result is only trustworthy when it actually resolved
 * historical USD prices.
 *
 * 2026-05-29 (MMaksimuk POS-024 prod incident): entries persisted during an
 * upstream price-feed outage carry `hasHistPrices:false` + `netCostBasisUsd:0`
 * even though their on-chain event amounts are correct. Concretely: the prod
 * Caddy `/defillama` proxy returned SPA HTML for a while, so `fetchHistoricalPrices`
 * yielded nothing and the Velodrome NFT cached as `{netCostBasisUsd:0,
 * hasHistPrices:false, totalDeposited0:0.0269, totalDeposited1:0.001}`. The
 * `useV3LiquidityEvents` module/localStorage cache then served that $0 forever —
 * the proxy fix alone never took effect because the hook early-returns from
 * cache and never recomputes. Such entries must be recomputed (and not
 * re-persisted), never trusted, once the feed recovers.
 */
export function isTrustworthyCostBasis(
  r: Pick<V3CostBasisResult, "hasHistPrices">,
): boolean {
  return r.hasHistPrices === true;
}

export interface V3CostBasisResult {
  /** tokenId NFT (для match'а с V3Position). */
  tokenId: bigint;
  /** Σ amount0 из всех IncreaseLiquidity events (human-readable). */
  totalDeposited0: number;
  /** Σ amount1. */
  totalDeposited1: number;
  /** Σ amount0 из DecreaseLiquidity (что вышло). */
  totalWithdrawn0: number;
  totalWithdrawn1: number;
  /** Σ deposit USD на момент каждого event'а (через historical prices). */
  totalDepositUsd: number;
  /** Σ withdraw USD по hist prices. */
  totalWithdrawUsd: number;
  /** Net cost basis = deposit - withdraw (с учётом WAC). */
  netCostBasisUsd: number;
  /** Кол-во events для debug. */
  eventCount: { increase: number; decrease: number };
  /** Использованы ли historical prices (false = DeBank current spot fallback). */
  hasHistPrices: boolean;
  /** Tx hash earliest IncreaseLiquidity = mint tx. Используется для match'а
   *  с OpenPosition.openHash в v3_cost_basis_override.ts (per-NFT precision). */
  mintTxHash?: string;
  /** Block timestamp earliest IncreaseLiquidity = mint time. Используется для
   *  fill'а OpenPosition.openedAt у orphan NFT'ов (где mint не в registry). */
  mintBlockTime?: number;
  /**
   * PR-2 (2026-05-25): per-tx DecreaseLiquidity амounts. Используется в
   * `computeClaimedFeesUsd` / `buildClaimedFeesHistory` чтобы отделить
   * principal portion (= DecreaseLiquidity.amount0/1) от collect fees,
   * когда `multicall(decreaseLiquidity, collect)` mis-classify'ятся как
   * claim_rewards с inflated amount (lex POS-007: $701 principal listed
   * as fee, real fee ~\$15).
   *
   * Key: txHash (lowercased). Value: per-token raw amounts (decimals
   * applied при consumption).
   */
  withdrawalsByTxHash?: Map<string, { amount0: number; amount1: number }>;
}
