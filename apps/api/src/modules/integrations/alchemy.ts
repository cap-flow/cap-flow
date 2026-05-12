import {
  type IBalanceProvider,
  type BalanceEntry,
  ProviderError,
  ProviderNotConfiguredError,
} from "./types.js";

/**
 * Alchemy multi-chain token-balance client.
 *
 * Uses chain-specific JSON-RPC endpoints + Alchemy's
 * `alchemy_getTokenBalances` method. The bulk refresh pipeline pairs
 * Alchemy with DeBank: Alchemy gives authoritative raw on-chain balances,
 * DeBank gives aggregated USD + DeFi positions. The refresh service can
 * cross-check and surface discrepancies via tech-audit.
 *
 * Endpoint shape: `https://<chain>.g.alchemy.com/v2/<api-key>`.
 */
export interface AlchemyTokenBalance {
  readonly contractAddress: string;
  readonly tokenBalanceHex: string;
}

interface AlchemyRpcResponse<T> {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: T;
  readonly error?: { code: number; message: string };
}

interface AlchemyGetTokenBalancesResult {
  readonly address: string;
  readonly tokenBalances: ReadonlyArray<{
    contractAddress: string;
    tokenBalance: string | null;
    error?: string | null;
  }>;
}

export class AlchemyClient implements IBalanceProvider {
  readonly name = "alchemy" as const;

  constructor(private readonly apiKey: string | undefined) {}

  get isLive(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  async getTokenBalances(
    chainId: number,
    address: string
  ): Promise<AlchemyTokenBalance[]> {
    if (!this.isLive) throw new ProviderNotConfiguredError("alchemy");
    const host = alchemyHostForChain(chainId);
    if (!host) {
      throw new ProviderError(
        `Alchemy does not support chainId ${chainId}`,
        "alchemy"
      );
    }
    const url = `https://${host}/v2/${this.apiKey}`;
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "alchemy_getTokenBalances",
      params: [address, "erc20"],
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new ProviderError(
        `Alchemy ${res.status} ${res.statusText}`,
        "alchemy",
        res.status
      );
    }
    const json =
      (await res.json()) as AlchemyRpcResponse<AlchemyGetTokenBalancesResult>;
    if (json.error) {
      throw new ProviderError(
        `Alchemy RPC: ${json.error.message}`,
        "alchemy"
      );
    }
    const items = json.result?.tokenBalances ?? [];
    return items
      .filter((it) => !it.error && it.tokenBalance)
      .map((it) => ({
        contractAddress: it.contractAddress,
        tokenBalanceHex: it.tokenBalance ?? "0x0",
      }));
  }

  /**
   * IBalanceProvider contract. Returns raw integer balances (no
   * decimal-division) — caller resolves token decimals via the
   * coingecko registry or `alchemy_getTokenMetadata` on-demand.
   *
   * `symbol` is left empty here for the same reason: the refresh
   * service resolves it from `contractAddress` against the global
   * registry, and tokens that don't resolve surface as "unknown" in
   * the admin tech-audit.
   */
  async getWalletBalances(
    chainId: number,
    address: string
  ): Promise<BalanceEntry[]> {
    const items = await this.getTokenBalances(chainId, address);
    return items.map((it) => ({
      symbol: "",
      amount: hexToDecimalString(it.tokenBalanceHex),
      chainId,
      contractAddress: it.contractAddress,
    }));
  }
}

function alchemyHostForChain(chainId: number): string | null {
  switch (chainId) {
    case 1:
      return "eth-mainnet.g.alchemy.com";
    case 10:
      return "opt-mainnet.g.alchemy.com";
    case 56:
      return "bnb-mainnet.g.alchemy.com";
    case 137:
      return "polygon-mainnet.g.alchemy.com";
    case 8453:
      return "base-mainnet.g.alchemy.com";
    case 42161:
      return "arb-mainnet.g.alchemy.com";
    case 43114:
      return "avax-mainnet.g.alchemy.com";
    default:
      return null;
  }
}

/** 0x-prefixed hex → decimal string. Uses BigInt to keep 18-decimal balances. */
function hexToDecimalString(hex: string): string {
  if (!hex || !hex.startsWith("0x")) return "0";
  try {
    return BigInt(hex).toString(10);
  } catch {
    return "0";
  }
}
