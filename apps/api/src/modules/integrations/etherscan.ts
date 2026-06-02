/**
 * Server-side Etherscan v2 unified client — token-transfer fetch.
 *
 * Thin wrapper over `UpstreamProxyService.forward` (provider "etherscan") so it
 * reuses the proxy's apikey injection, path allow-list, and retry/backoff — the
 * same B-port pattern as `KrystalClient`. Mirrors the web `lib/etherscan_logs.ts`
 * (`fetchEtherscanWalletTokenTransfers` / `fetchEtherscanTokenTransfers`):
 *   - `account/tokentx` with only `address` → ALL wallet token transfers
 *   - `account/tokentx` with `contractaddress` + `address` → one token's transfers
 *
 * Used by the B4 non-LP opener fetch (`NonLpOpenerSource`) to read the raw
 * on-chain ERC20 receipt-token history that the pure resolvers
 * (`@cap-flow/ucb/non_lp_opener_resolve`) turn into a `NonLpOpener`. Etherscan v2
 * is the authoritative source for the open date — DeBank classification is not.
 *
 * Fail-soft is the CALLER's responsibility (the source wraps per-wallet errors);
 * here a non-200 / Etherscan error throws so the caller can distinguish an
 * unsupported chain (→ Alchemy fallback) from a transient failure.
 */
import type { WalletTransfer } from "@cap-flow/ucb/non_lp_opener_resolve";
import type { V3LiquidityEvent } from "@cap-flow/ucb/v3_types";

/** V3 NPM event topic0 signatures (keccak256). */
const INCREASE_LIQ_TOPIC =
  "0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f";
const DECREASE_LIQ_TOPIC =
  "0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4";

/** chainCode → Etherscan v2 chainId. */
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

/**
 * Thrown when Etherscan free tier does not support a chain (e.g. BASE). The
 * caller (`NonLpOpenerSource`) falls back to Alchemy `getAssetTransfers`.
 */
export class EtherscanChainNotSupportedError extends Error {
  readonly chainCode: string;
  constructor(chainCode: string) {
    super(`Etherscan free tier doesn't support chain: ${chainCode}`);
    this.name = "EtherscanChainNotSupportedError";
    this.chainCode = chainCode;
  }
}

/** The slice of UpstreamProxyService this client needs (injectable for tests). */
export interface EtherscanProxy {
  forward(req: {
    provider: "etherscan";
    method: "GET";
    path: string;
    query?: Record<string, string | string[] | undefined>;
    signal?: AbortSignal;
  }): Promise<{ status: number; body: string }>;
}

/** Per-token transfer (matches the web `EtherscanTokenTransfer`). */
export interface EtherscanTokenTransfer {
  hash: string;
  timeStamp: number;
  blockNumber: number;
  from: string;
  to: string;
  value: string;
  tokenDecimal: number;
}

interface RawTokenTx {
  hash: string;
  timeStamp: string;
  blockNumber: string;
  from: string;
  to: string;
  contractAddress?: string;
  value: string;
  tokenDecimal: string;
  tokenSymbol?: string;
}

interface EtherscanBody {
  status: string;
  message: string;
  result: string | RawTokenTx[];
}

/**
 * Classify a non-"1" Etherscan response: empty result / "No transactions" →
 * `[]`; "Free API access is not supported" → unsupported chain; else throw.
 */
function emptyOrThrow(chainCode: string, json: EtherscanBody, ctx: string): [] {
  if (
    typeof json.result === "string" &&
    json.result.includes("No transactions")
  ) {
    return [];
  }
  if (Array.isArray(json.result) && json.result.length === 0) return [];
  if (
    typeof json.result === "string" &&
    json.result.includes("Free API access is not supported")
  ) {
    throw new EtherscanChainNotSupportedError(chainCode);
  }
  throw new Error(`Etherscan ${ctx}: ${json.message} ${String(json.result)}`);
}

export class EtherscanClient {
  readonly name = "etherscan" as const;

  constructor(private readonly proxy: EtherscanProxy) {}

  private async tokenTx(
    chainCode: string,
    query: Record<string, string>,
    ctx: string,
    signal?: AbortSignal,
  ): Promise<RawTokenTx[]> {
    const chainId = CHAIN_TO_ID[chainCode.toLowerCase()];
    if (!chainId) throw new Error(`Etherscan: unknown chain ${chainCode}`);
    const res = await this.proxy.forward({
      provider: "etherscan",
      method: "GET",
      path: "v2/api",
      query: { chainid: String(chainId), module: "account", action: "tokentx", ...query },
      ...(signal !== undefined && { signal }),
    });
    if (res.status !== 200) {
      throw new Error(`Etherscan HTTP ${res.status}: ${res.body.slice(0, 120)}`);
    }
    let json: EtherscanBody;
    try {
      json = JSON.parse(res.body) as EtherscanBody;
    } catch {
      throw new Error(`Etherscan ${ctx}: non-JSON body`);
    }
    if (json.status !== "1") return emptyOrThrow(chainCode, json, ctx);
    return Array.isArray(json.result) ? json.result : [];
  }

  /**
   * ALL ERC20 token transfers of a wallet (no contract filter), sort=asc. Lets
   * the resolver match the first interaction with ANY contract (stake-in:
   * to==contract; vault mint: contract==receiptToken). Up to 10k transfers
   * (Etherscan cap, no pagination — our wallets are well within it).
   */
  async fetchWalletTokenTransfers(
    chainCode: string,
    wallet: string,
    signal?: AbortSignal,
  ): Promise<WalletTransfer[]> {
    const rows = await this.tokenTx(
      chainCode,
      { address: wallet, sort: "asc", offset: "10000", page: "1" },
      "tokentx(all)",
      signal,
    );
    return rows.map((r) => ({
      hash: r.hash,
      timeStamp: Number(r.timeStamp),
      blockNumber: Number(r.blockNumber),
      from: r.from.toLowerCase(),
      to: r.to.toLowerCase(),
      contractAddress: (r.contractAddress ?? "").toLowerCase(),
      value: r.value,
      tokenDecimal: Number(r.tokenDecimal),
      tokenSymbol: r.tokenSymbol ?? "",
    }));
  }

  /**
   * Token transfers for ONE (contract, wallet) pair, sort=asc. Used for the
   * single-receipt opener path (`detectNonLpOpener` analogue).
   */
  async fetchTokenTransfers(
    chainCode: string,
    contractAddress: string,
    wallet: string,
    signal?: AbortSignal,
  ): Promise<EtherscanTokenTransfer[]> {
    const rows = await this.tokenTx(
      chainCode,
      { contractaddress: contractAddress, address: wallet, sort: "asc" },
      "tokentx",
      signal,
    );
    return rows.map((r) => ({
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
   * All IncreaseLiquidity + DecreaseLiquidity events for one V3 NFT, via
   * `module=logs&action=getLogs` (topic0 = event sig, topic1 = tokenId). Etherscan
   * free tier has NO block-range limit (1000 results/call). Returns parsed events
   * with amounts/blockTime/txHash for `computeV3CostBasis`.
   */
  async fetchV3LiquidityEvents(
    chainCode: string,
    npm: string,
    tokenId: bigint,
    signal?: AbortSignal,
  ): Promise<{ increases: V3LiquidityEvent[]; decreases: V3LiquidityEvent[] }> {
    const topic1 = "0x" + tokenId.toString(16).padStart(64, "0");
    const [inc, dec] = await Promise.all([
      this.getLiquidityLogs(chainCode, npm, INCREASE_LIQ_TOPIC, topic1, "increase", tokenId, signal),
      this.getLiquidityLogs(chainCode, npm, DECREASE_LIQ_TOPIC, topic1, "decrease", tokenId, signal),
    ]);
    return { increases: inc, decreases: dec };
  }

  private async getLiquidityLogs(
    chainCode: string,
    address: string,
    topic0: string,
    topic1: string,
    type: "increase" | "decrease",
    tokenId: bigint,
    signal?: AbortSignal,
  ): Promise<V3LiquidityEvent[]> {
    const chainId = CHAIN_TO_ID[chainCode.toLowerCase()];
    if (!chainId) throw new Error(`Etherscan: unknown chain ${chainCode}`);
    const res = await this.proxy.forward({
      provider: "etherscan",
      method: "GET",
      path: "v2/api",
      query: {
        chainid: String(chainId),
        module: "logs",
        action: "getLogs",
        address,
        topic0,
        topic0_1_opr: "and",
        topic1,
        fromBlock: "0",
        toBlock: "latest",
      },
      ...(signal !== undefined && { signal }),
    });
    if (res.status !== 200) {
      throw new Error(`Etherscan HTTP ${res.status}: ${res.body.slice(0, 120)}`);
    }
    let json: { status: string; message: string; result: string | RawLog[] };
    try {
      json = JSON.parse(res.body);
    } catch {
      throw new Error("Etherscan getLogs: non-JSON body");
    }
    if (json.status !== "1") {
      if (typeof json.result === "string" && json.result.includes("No records found")) return [];
      if (Array.isArray(json.result) && json.result.length === 0) return [];
      if (json.message === "No records found") return [];
      if (typeof json.result === "string" && json.result.includes("Free API access is not supported")) {
        throw new EtherscanChainNotSupportedError(chainCode);
      }
      throw new Error(`Etherscan getLogs: ${json.message} ${String(json.result)}`);
    }
    if (!Array.isArray(json.result)) return [];
    return json.result.map((log) => parseLiquidityLog(log, type, tokenId));
  }
}

interface RawLog {
  data: string;
  blockNumber: string; // hex
  timeStamp: string; // hex
  transactionHash: string;
}

/** Parse an IncreaseLiquidity/DecreaseLiquidity getLogs entry → V3LiquidityEvent. */
function parseLiquidityLog(
  log: RawLog,
  type: "increase" | "decrease",
  tokenId: bigint,
): V3LiquidityEvent {
  // data = liquidity(uint128 padded 32) + amount0(uint256 32) + amount1(uint256 32)
  const d = log.data.startsWith("0x") ? log.data.slice(2) : log.data;
  const liquidity = BigInt("0x" + d.slice(0, 64));
  const amount0Raw = BigInt("0x" + d.slice(64, 128));
  const amount1Raw = BigInt("0x" + d.slice(128, 192));
  return {
    type,
    tokenId,
    blockNumber: BigInt(log.blockNumber),
    blockTime: Number(BigInt(log.timeStamp)),
    txHash: log.transactionHash,
    liquidity,
    amount0Raw,
    amount1Raw,
  };
}
