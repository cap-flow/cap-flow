/**
 * Etherscan v2 unified API для on-chain log queries.
 *
 * Решает проблему Alchemy Free tier (10-block range limit) для V3 NFT
 * `IncreaseLiquidity` events. Etherscan free tier: 5 req/s, **БЕЗ
 * block-range limit** (1000 results per call).
 *
 * Endpoint: `https://api.etherscan.io/v2/api?chainId={N}&module=logs&...`
 *
 * Multi-chain через `chainId` param:
 *   1   = Ethereum
 *   42161 = Arbitrum
 *   10  = Optimism
 *   137 = Polygon
 *   8453 = Base
 *   56  = BNB Chain
 *
 * **Phase S3**: запросы идут через backend upstream-proxy
 * (`/api/v1/upstream/etherscan/*`). Бекенд инжектит `&apikey=...` со
 * своим (admin'овским) ключом. Параметр `apikey` в сигнатуре оставлен
 * для совместимости — value игнорируется (удалится в S4).
 */

import { apiFetch } from "./api/client";

const PROXY = "/v1/upstream/etherscan";

/**
 * Кидается когда Etherscan free tier не поддерживает данную сеть
 * (например BASE). Caller может сделать fallback на Alchemy.
 */
export class EtherscanChainNotSupportedError extends Error {
  readonly chainCode: string;
  constructor(chainCode: string) {
    super(`Etherscan free tier doesn't support chain: ${chainCode}`);
    this.name = "EtherscanChainNotSupportedError";
    this.chainCode = chainCode;
  }
}

/** Маппинг chain code → Etherscan chainId. */
const CHAIN_TO_ID: Record<string, number> = {
  eth: 1,
  arb: 42161,
  op: 10,
  matic: 137,
  base: 8453,
  bsc: 56,
  avax: 43114,
  ftm: 250,
};

interface EtherscanLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string; // hex
  timeStamp: string; // hex
  transactionHash: string;
  transactionIndex: string; // hex
  logIndex: string; // hex
  gasPrice: string;
  gasUsed: string;
}

interface EtherscanResponse {
  status: string; // "1" | "0"
  message: string;
  result: EtherscanLog[] | string;
}

/**
 * Запросить логи через Etherscan v2 API.
 *
 * @param chainCode — eth/arb/op/...
 * @param contractAddress — адрес контракта (NPM для Uniswap V3)
 * @param topic0 — keccak256 event signature
 * @param topic1 — first indexed param (filter, например NFT tokenId hex-padded)
 * @param fromBlock — start block (default 0 = earliest)
 * @param apikey — Etherscan API key
 */
export async function fetchEtherscanLogs(
  chainCode: string,
  contractAddress: string,
  topic0: string,
  topic1: string | null,
  apikey: string,
  options?: {
    fromBlock?: number | "latest" | "earliest";
    toBlock?: number | "latest" | "earliest";
  },
): Promise<EtherscanLog[]> {
  const chainId = CHAIN_TO_ID[chainCode.toLowerCase()];
  if (!chainId) throw new Error(`Etherscan: unknown chain ${chainCode}`);
  // S3: apikey ignored — backend injects its own.
  void apikey;

  // КРИТИЧНО: порядок параметров важен для Etherscan v2 API.
  // topic1 + topic0_1_opr ДОЛЖНЫ идти СРАЗУ после topic0, иначе API
  // их игнорирует и возвращает No records (или весь pool без фильтра).
  const baseParams: Record<string, string> = {
    chainid: chainId.toString(),
    module: "logs",
    action: "getLogs",
    address: contractAddress,
    topic0,
  };
  if (topic1) {
    baseParams.topic0_1_opr = "and";
    baseParams.topic1 = topic1;
  }
  baseParams.fromBlock = String(options?.fromBlock ?? 0);
  baseParams.toBlock = String(options?.toBlock ?? "latest");
  const params = new URLSearchParams(baseParams);

  const url = `${PROXY}/v2/api?${params.toString()}`;
  if (typeof window !== "undefined") {
    console.log("[etherscan] URL: " + url);
  }
  const res = await apiFetch(url);
  if (!res.ok) {
    throw new Error(`Etherscan HTTP ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as EtherscanResponse;
  if (json.status !== "1") {
    // Etherscan returns various forms for "no results":
    //   1) { status:"0", message:"No records found", result: "No records found" }
    //   2) { status:"0", message:"No records found", result: [] }
    // Both должны трактоваться как пустой результат, не как ошибка.
    if (typeof json.result === "string" && json.result.includes("No records found")) {
      return [];
    }
    if (json.message === "No records found") {
      return [];
    }
    if (Array.isArray(json.result) && json.result.length === 0) {
      return [];
    }
    // Etherscan free tier не поддерживает все сети (BASE, etc.).
    // Кидаем typed error чтобы caller мог сделать fallback на Alchemy.
    if (
      typeof json.result === "string" &&
      json.result.includes("Free API access is not supported for this chain")
    ) {
      throw new EtherscanChainNotSupportedError(chainCode);
    }
    throw new Error(`Etherscan API: ${json.message} ${json.result}`);
  }
  return Array.isArray(json.result) ? json.result : [];
}

/**
 * Декодировать uint256 (32 bytes hex) → bigint.
 */
function decodeUint256(hex: string): bigint {
  return BigInt(hex);
}

// ───────────────────────────────────────────────────────────────────────
//  Token transfers via `account/tokentx` endpoint
//
//  Используется для audit'а lending позиций: получаем все Mint/Burn events
//  aToken'а на адрес юзера. В отличие от `getLogs`, этот endpoint фильтрует
//  по address ↔ contract автоматически (нет multi-topic ограничений) и
//  возвращает уже распарсенные fields (from, to, value, hash, timeStamp).
// ───────────────────────────────────────────────────────────────────────

export interface EtherscanTokenTransfer {
  /** Tx hash. */
  hash: string;
  /** Unix seconds. */
  timeStamp: number;
  /** Block number. */
  blockNumber: number;
  /** From address (0x0 = mint). */
  from: string;
  /** To address (0x0 = burn). */
  to: string;
  /** Raw value (uint256 в native units). Делить на 10^tokenDecimal. */
  value: string;
  /** Decimals от Etherscan API. */
  tokenDecimal: number;
}

/**
 * Запросить все Token Transfers для (contractAddress, walletAddress) пары
 * через Etherscan v2 `account/tokentx` endpoint.
 *
 * Возвращает массив сверху-вниз (sort=asc, старые first). Ограничение
 * Etherscan: 10 000 транзакций (pagination не реализована — для наших
 * целей aToken'ов вряд ли нужна).
 */
export async function fetchEtherscanTokenTransfers(
  chainCode: string,
  contractAddress: string,
  walletAddress: string,
  apikey: string,
): Promise<EtherscanTokenTransfer[]> {
  const chainId = CHAIN_TO_ID[chainCode.toLowerCase()];
  if (!chainId) throw new Error(`Etherscan: unknown chain ${chainCode}`);
  // S3: apikey ignored — backend injects its own.
  void apikey;

  const params = new URLSearchParams({
    chainid: chainId.toString(),
    module: "account",
    action: "tokentx",
    contractaddress: contractAddress,
    address: walletAddress,
    sort: "asc",
  });
  const url = `${PROXY}/v2/api?${params.toString()}`;
  const res = await apiFetch(url);
  if (!res.ok) {
    throw new Error(`Etherscan HTTP ${res.status}: ${await res.text()}`);
  }
  const json = await res.json() as {
    status: string;
    message: string;
    result:
      | string
      | Array<{
          hash: string;
          timeStamp: string;
          blockNumber: string;
          from: string;
          to: string;
          value: string;
          tokenDecimal: string;
        }>;
  };
  if (json.status !== "1") {
    if (typeof json.result === "string" && json.result.includes("No transactions")) {
      return [];
    }
    if (Array.isArray(json.result) && json.result.length === 0) {
      return [];
    }
    if (
      typeof json.result === "string" &&
      json.result.includes("Free API access is not supported")
    ) {
      throw new EtherscanChainNotSupportedError(chainCode);
    }
    throw new Error(`Etherscan tokentx: ${json.message} ${json.result}`);
  }
  if (!Array.isArray(json.result)) return [];
  return json.result.map((r) => ({
    hash: r.hash,
    timeStamp: Number(r.timeStamp),
    blockNumber: Number(r.blockNumber),
    from: r.from.toLowerCase(),
    to: r.to.toLowerCase(),
    value: r.value,
    tokenDecimal: Number(r.tokenDecimal),
  }));
}

/**
 * Все token-transfers кошелька БЕЗ фильтра по контракту (Etherscan v2
 * `account/tokentx` с одним только `address`). Возвращает from/to/contract
 * для каждого transfer'а — позволяет искать «первое взаимодействие с любым
 * контрактом» (stake-in: to==stakingContract; vault mint: from==vault,
 * to==wallet; receipt: contract==receiptToken).
 *
 * 2026-05-28 (Stage 1c non-LP opener): для staking/locked/lending позиций
 * `lpTokenId` — это адрес контракта, а НЕ transferable receipt-токен. Поэтому
 * фильтр по `contractaddress=lpTokenId` (как в fetchEtherscanTokenTransfers)
 * возвращает пусто. Здесь берём ВСЮ историю transfer'ов кошелька и матчим
 * по `to == lpTokenId` (депозит токена в контракт) — это даёт дату открытия.
 *
 * Sort asc, до 10k transfer'ов (Etherscan лимит без pagination). Для наших
 * кошельков обычно сотни — первый match рано.
 */
export async function fetchEtherscanWalletTokenTransfers(
  chainCode: string,
  walletAddress: string,
): Promise<Array<EtherscanTokenTransfer & { from: string; to: string; contractAddress: string }>> {
  const chainId = CHAIN_TO_ID[chainCode.toLowerCase()];
  if (!chainId) throw new Error(`Etherscan: unknown chain ${chainCode}`);

  const params = new URLSearchParams({
    chainid: chainId.toString(),
    module: "account",
    action: "tokentx",
    address: walletAddress,
    sort: "asc",
    offset: "10000",
    page: "1",
  });
  const url = `${PROXY}/v2/api?${params.toString()}`;
  const res = await apiFetch(url);
  if (!res.ok) {
    throw new Error(`Etherscan HTTP ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    status: string;
    message: string;
    result:
      | string
      | Array<{
          hash: string;
          timeStamp: string;
          blockNumber: string;
          from: string;
          to: string;
          contractAddress: string;
          value: string;
          tokenDecimal: string;
        }>;
  };
  if (json.status !== "1") {
    if (typeof json.result === "string" && json.result.includes("No transactions")) {
      return [];
    }
    if (Array.isArray(json.result) && json.result.length === 0) return [];
    if (
      typeof json.result === "string" &&
      json.result.includes("Free API access is not supported")
    ) {
      throw new EtherscanChainNotSupportedError(chainCode);
    }
    throw new Error(`Etherscan tokentx(all): ${json.message} ${json.result}`);
  }
  if (!Array.isArray(json.result)) return [];
  return json.result.map((r) => ({
    hash: r.hash,
    timeStamp: Number(r.timeStamp),
    blockNumber: Number(r.blockNumber),
    from: r.from.toLowerCase(),
    to: r.to.toLowerCase(),
    contractAddress: r.contractAddress.toLowerCase(),
    value: r.value,
    tokenDecimal: Number(r.tokenDecimal),
  }));
}

/** Pad uint256 → 64 hex chars + '0x' prefix (для topic encoding). */
export function uint256ToTopic(value: bigint): string {
  return "0x" + value.toString(16).padStart(64, "0");
}

/** Парс IncreaseLiquidity log в типизированную форму. */
export interface ParsedLiquidityLog {
  txHash: string;
  blockNumber: bigint;
  blockTime: number; // unix seconds
  tokenId: bigint;
  liquidity: bigint;
  amount0: bigint;
  amount1: bigint;
}

export function parseLiquidityLog(log: EtherscanLog): ParsedLiquidityLog {
  // event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
  // topics[0] = event sig
  // topics[1] = tokenId (indexed)
  // data = packed (liquidity uint128 + amount0 uint256 + amount1 uint256)
  // = 32 bytes (liquidity packed as 32 bytes) + 32 bytes (amount0) + 32 bytes (amount1)
  const dataNoPrefix = log.data.slice(2);
  const liquidityHex = "0x" + dataNoPrefix.slice(0, 64);
  const amount0Hex = "0x" + dataNoPrefix.slice(64, 128);
  const amount1Hex = "0x" + dataNoPrefix.slice(128, 192);
  return {
    txHash: log.transactionHash,
    blockNumber: BigInt(log.blockNumber),
    blockTime: Number(BigInt(log.timeStamp)),
    tokenId: decodeUint256(log.topics[1]!),
    liquidity: decodeUint256(liquidityHex),
    amount0: decodeUint256(amount0Hex),
    amount1: decodeUint256(amount1Hex),
  };
}
