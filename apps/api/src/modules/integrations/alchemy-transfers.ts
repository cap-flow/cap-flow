/**
 * Server-side Alchemy `getAssetTransfers` client — non-LP opener FALLBACK for
 * chains Etherscan free tier does not support (BASE, Avalanche).
 *
 * Proxy-based (provider "alchemy", POST JSON-RPC) so it reuses the admin key +
 * retry/backoff — same pattern as `KrystalClient`/`EtherscanClient`. Mirrors the
 * web `lib/nonlp/alchemy_transfers.ts`:
 *   - fetchWalletTransfers → ERC20 transfers (toAddress + fromAddress, 2 calls)
 *   - fetchBlockTimestamps → eth_getBlockByNumber per block (Avalanche has no
 *     metadata.blockTimestamp on getAssetTransfers)
 */
import type { AlchemyTransfer } from "@cap-flow/ucb/non_lp_opener_resolve";

/** chainCode → Alchemy subdomain (the upstream-proxy ALCHEMY_CHAINS set). */
const CHAIN_TO_SUBDOMAIN: Record<string, string> = {
  eth: "eth-mainnet",
  arb: "arb-mainnet",
  op: "opt-mainnet",
  matic: "polygon-mainnet",
  base: "base-mainnet",
  bsc: "bnb-mainnet",
  avax: "avax-mainnet",
};

export function isAlchemyChainSupported(chainCode: string): boolean {
  return CHAIN_TO_SUBDOMAIN[chainCode.toLowerCase()] != null;
}

/** The slice of UpstreamProxyService this client needs (injectable for tests). */
export interface AlchemyRpcProxy {
  forward(req: {
    provider: "alchemy";
    method: "POST";
    path: string;
    body: unknown;
    signal?: AbortSignal;
  }): Promise<{ status: number; body: string }>;
}

interface RawAssetTransfer {
  blockNum: string;
  hash?: string;
  from: string;
  to: string | null;
  asset?: string | null;
  rawContract?: {
    address?: string | null;
    value?: string | null;
    decimal?: string | null;
  };
}

function mapTransfers(result: unknown): AlchemyTransfer[] {
  const transfers =
    (result as { transfers?: RawAssetTransfer[] })?.transfers ?? [];
  const out: AlchemyTransfer[] = [];
  for (const t of transfers) {
    if (!t.blockNum) continue;
    const rawVal = t.rawContract?.value;
    const dec = t.rawContract?.decimal;
    let amount = 0;
    if (rawVal && dec) {
      try {
        amount = Number(BigInt(rawVal)) / 10 ** Number(BigInt(dec));
      } catch {
        amount = 0;
      }
    }
    out.push({
      blockNumber: Number(BigInt(t.blockNum)),
      hash: t.hash ?? "",
      from: (t.from ?? "").toLowerCase(),
      to: (t.to ?? "").toLowerCase(),
      contractAddress: (t.rawContract?.address ?? "").toLowerCase(),
      amount,
      symbol: t.asset ?? "",
    });
  }
  return out;
}

export class AlchemyTransfersClient {
  constructor(private readonly proxy: AlchemyRpcProxy) {}

  private async rpc(
    chainCode: string,
    method: string,
    params: unknown[],
    signal?: AbortSignal,
  ): Promise<unknown> {
    const sub = CHAIN_TO_SUBDOMAIN[chainCode.toLowerCase()];
    if (!sub) throw new Error(`Alchemy: unknown chain ${chainCode}`);
    const res = await this.proxy.forward({
      provider: "alchemy",
      method: "POST",
      path: sub,
      body: { jsonrpc: "2.0", id: 1, method, params },
      ...(signal !== undefined && { signal }),
    });
    if (res.status !== 200) {
      throw new Error(`Alchemy HTTP ${res.status}: ${res.body.slice(0, 120)}`);
    }
    const json = JSON.parse(res.body) as {
      result?: unknown;
      error?: { message?: string };
    };
    if (json.error) {
      throw new Error(`Alchemy RPC: ${json.error.message ?? "unknown"}`);
    }
    return json.result;
  }

  /** All ERC20 transfers of a wallet (incoming + outgoing), 2 calls. */
  async fetchWalletTransfers(
    chainCode: string,
    wallet: string,
    signal?: AbortSignal,
  ): Promise<AlchemyTransfer[]> {
    const common = {
      fromBlock: "0x0",
      toBlock: "latest",
      category: ["erc20"],
      order: "asc",
      maxCount: "0x3e8", // 1000
    };
    const [incoming, outgoing] = await Promise.all([
      this.rpc(chainCode, "alchemy_getAssetTransfers", [
        { ...common, toAddress: wallet },
      ], signal),
      this.rpc(chainCode, "alchemy_getAssetTransfers", [
        { ...common, fromAddress: wallet },
      ], signal),
    ]);
    return [...mapTransfers(incoming), ...mapTransfers(outgoing)];
  }

  /** Resolve unix timestamps for a set of blocks via eth_getBlockByNumber. */
  async fetchBlockTimestamps(
    chainCode: string,
    blockNumbers: readonly number[],
    signal?: AbortSignal,
  ): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    const unique = Array.from(new Set(blockNumbers));
    const results = await Promise.all(
      unique.map(async (bn) => {
        const block = (await this.rpc(
          chainCode,
          "eth_getBlockByNumber",
          ["0x" + bn.toString(16), false],
          signal,
        )) as { timestamp?: string } | null;
        return {
          bn,
          ts: block?.timestamp ? Number(BigInt(block.timestamp)) : null,
        };
      }),
    );
    for (const { bn, ts } of results) {
      if (ts != null) out.set(bn, ts);
    }
    return out;
  }
}
