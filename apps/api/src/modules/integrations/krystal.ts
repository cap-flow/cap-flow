/**
 * B3 — server-side Krystal Cloud client (V3 LP positions + per-NFT transactions).
 *
 * Thin wrapper over `UpstreamProxyService.forward` so it reuses the proxy's
 * KC-APIKey injection, path allow-list, and retry/backoff — no separate fetch
 * stack. Mirrors the web client (`apps/web/src/lib/krystal/client.ts`):
 *   - openUniswapV3Positions → GET v1/positions?wallet&positionStatus=OPEN&protocols=uniswap
 *   - positionTransactions   → GET v1/positions/{chainId}/{npm}-{tokenId}/transactions
 *
 * Fail-soft by design: any non-200 (402 out-of-credits, 401 missing key, 404 no
 * txs, 5xx) → empty result. The KrystalV3Source layer also wraps per-wallet
 * errors, so a Krystal outage never blocks the shadow.
 */
import type {
  KrystalPosition,
  KrystalTransaction,
} from "@cap-flow/ucb/krystal/types";

/** The slice of UpstreamProxyService this client needs (injectable for tests). */
export interface KrystalProxy {
  forward(req: {
    provider: "krystal";
    method: "GET";
    path: string;
    query?: Record<string, string | string[] | undefined>;
  }): Promise<{ status: number; body: string }>;
}

function parseJsonArray<T>(body: string): T[] {
  try {
    const v = JSON.parse(body);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

export class KrystalClient {
  constructor(private readonly proxy: KrystalProxy) {}

  /** OPEN Uniswap V3/V4 LP positions for an EVM wallet. [] on any non-200. */
  async openUniswapV3Positions(wallet: string): Promise<KrystalPosition[]> {
    const res = await this.proxy.forward({
      provider: "krystal",
      method: "GET",
      path: "v1/positions",
      query: { wallet, positionStatus: "OPEN", protocols: "uniswap" },
    });
    if (res.status !== 200) return [];
    return parseJsonArray<KrystalPosition>(res.body);
  }

  /**
   * Per-NFT transaction history (DEPOSIT/WITHDRAW/COLLECT_FEE). The override's V4
   * trust gate uses Σ DEPOSIT from here as authoritative cost basis. [] on non-200.
   */
  async positionTransactions(
    chainId: number,
    npmAddress: string,
    tokenId: string,
  ): Promise<KrystalTransaction[]> {
    const res = await this.proxy.forward({
      provider: "krystal",
      method: "GET",
      path: `v1/positions/${chainId}/${npmAddress}-${tokenId}/transactions`,
    });
    if (res.status !== 200) return [];
    return parseJsonArray<KrystalTransaction>(res.body);
  }
}
