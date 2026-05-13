import {
  type IBalanceProvider,
  type BalanceEntry,
  ProviderError,
  ProviderNotConfiguredError,
} from "./types.js";

/**
 * DeBank Cloud Pro API client.
 *
 *   Base:    https://pro-openapi.debank.com
 *   Auth:    `AccessKey: <DEBANK_API_KEY>` header
 *
 * Endpoints used:
 *   - GET /v1/user/total_balance?id=<address>
 *       → { total_usd_value, chain_list[] }
 *   - GET /v1/user/all_token_list?id=<address>&is_all=true
 *       → DeBankToken[]: tokens across all supported chains for the
 *         address (native + ERC20 + receipt tokens).
 *
 * Notes for cost-basis methodology (Capflow):
 *   - DeBank returns `m.usd` as *current* spot, not historical. The
 *     refresh service that consumes these balances must NOT use that as
 *     a cost basis — historical pricing comes from `CoinGecko` /
 *     `historical_prices` (see Phase 3).
 *   - Receipt-token balances may include both `is_lp = true` and bare
 *     tokens; the calling cost-basis tracker disambiguates via the
 *     distinct-receipts heuristic in
 *     `notes/decisions/cost-basis-architecture.md`.
 */
export interface DebankChainBalance {
  readonly id: string;
  readonly usdValue: number;
}

export interface DebankTotalBalance {
  readonly totalUsdValue: number;
  readonly chains: DebankChainBalance[];
}

export interface DebankToken {
  readonly chain: string;
  readonly symbol: string;
  readonly amount: number;
  readonly priceUsd: number;
  readonly contractAddress: string | null;
  readonly id: string;
}

interface DeBankTotalBalanceResponse {
  readonly total_usd_value: number;
  readonly chain_list: ReadonlyArray<{ id: string; usd_value: number }>;
}

interface DeBankUserToken {
  readonly id: string;
  readonly chain: string;
  readonly symbol: string;
  readonly amount: number;
  readonly price: number;
  readonly is_core?: boolean;
  readonly is_verified?: boolean;
}

/**
 * Aggregated DeFi position summary across all protocols. Lets the
 * dashboard split a wallet's value into 3 buckets:
 *   - walletUsd       — bare tokens lying in the wallet, not committed
 *                       to any DeFi protocol.
 *   - protocolsAssetUsd — Σ supply-side USD across all positions
 *                       (collateral, liquidity, vault deposits, …).
 *   - totalDebtUsd    — Σ borrow-side USD across all positions
 *                       (Aave/Compound/Morpho debt).
 *
 * Derived from `/v1/user/all_complex_protocol_list`: one DeBank credit
 * per call, returns *all* protocols across *all* chains for one address.
 */
export interface DebankProtocolsSummary {
  readonly protocolsAssetUsd: number;
  readonly totalDebtUsd: number;
  /** Source-of-truth list for `metrics.protocolsCount` etc. */
  readonly protocolsCount: number;
  /** Flattened supply tokens across every DeFi position. Used by the
   *  dashboard's allocation donut to attribute DeFi-locked value back
   *  to its underlying tokens (e.g. USDC supplied to Aave → bucket "USDC").
   *  Excludes debt tokens — those net against the supply side. */
  readonly supplyTokens: ReadonlyArray<{
    readonly symbol: string;
    readonly amount: number;
    readonly priceUsd: number;
    readonly chain: string;
  }>;
  /** Per-protocol aggregates across all positions for ONE address. The
   *  worker further groups these across addresses by (protocolId, chain)
   *  to feed metrics.protocols on the dashboard. */
  readonly protocols: ReadonlyArray<{
    readonly id: string;
    readonly chain: string;
    readonly name: string;
    readonly assetUsd: number;
    readonly debtUsd: number;
    /** Tokens user is supplying inside this protocol — symbol+amount+price. */
    readonly supplyTokens: ReadonlyArray<{
      readonly symbol: string;
      readonly amount: number;
      readonly priceUsd: number;
    }>;
    /** Tokens user is borrowing inside this protocol. */
    readonly debtTokens: ReadonlyArray<{
      readonly symbol: string;
      readonly amount: number;
      readonly priceUsd: number;
    }>;
  }>;
}

interface DeBankSupplyToken {
  readonly symbol: string;
  readonly chain: string;
  readonly amount: number;
  readonly price: number;
}

interface DeBankProtocolPortfolioItem {
  readonly stats?: {
    readonly asset_usd_value?: number;
    readonly debt_usd_value?: number;
    readonly net_usd_value?: number;
  };
  readonly detail?: {
    readonly supply_token_list?: ReadonlyArray<DeBankSupplyToken>;
    readonly borrow_token_list?: ReadonlyArray<DeBankSupplyToken>;
  };
}

interface DeBankComplexProtocol {
  readonly id: string;
  readonly chain: string;
  readonly name?: string;
  readonly portfolio_item_list?: ReadonlyArray<DeBankProtocolPortfolioItem>;
  readonly net_usd_value?: number;
  readonly asset_usd_value?: number;
  readonly debt_usd_value?: number;
}

/**
 * Subset of DeBank's `/v1/user/all_history_list` response, kept loose
 * (`unknown` per inner record) so this client doesn't reshape the
 * provider's payload. The chain classifier owns the strict types and
 * parses them in `apps/api/src/modules/classifier/debank_types.ts`.
 */
export interface DeBankHistoryBundle {
  history_list: Array<Record<string, unknown> & { id: string; time_at: number }>;
  token_dict: Record<string, unknown>;
  project_dict: Record<string, unknown>;
  cex_dict: Record<string, unknown>;
}

export interface GetHistoryOptions {
  /** Hard cap on pagination loops (each page = 20 tx). Default 10. */
  readonly maxPages?: number;
  /** Restrict to specific DeBank chain ids (e.g. "eth,arb,op"). */
  readonly chainIds?: string;
}

export class DeBankClient implements IBalanceProvider {
  readonly name = "debank" as const;
  private readonly base = "https://pro-openapi.debank.com";

  constructor(private readonly apiKey: string | undefined) {}

  get isLive(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  async getTotalBalance(address: string): Promise<DebankTotalBalance> {
    if (!this.isLive) throw new ProviderNotConfiguredError("debank");
    const url = new URL(`${this.base}/v1/user/total_balance`);
    url.searchParams.set("id", address);
    const body = await this.fetchJson<DeBankTotalBalanceResponse>(url);
    return {
      totalUsdValue: body.total_usd_value ?? 0,
      chains: (body.chain_list ?? []).map((c) => ({
        id: c.id,
        usdValue: c.usd_value ?? 0,
      })),
    };
  }

  async getAllTokens(address: string): Promise<DebankToken[]> {
    if (!this.isLive) throw new ProviderNotConfiguredError("debank");
    const url = new URL(`${this.base}/v1/user/all_token_list`);
    url.searchParams.set("id", address);
    url.searchParams.set("is_all", "true");
    const body = await this.fetchJson<DeBankUserToken[]>(url);
    return body.map((t) => ({
      id: t.id,
      chain: t.chain,
      symbol: t.symbol,
      amount: Number(t.amount ?? 0),
      priceUsd: Number(t.price ?? 0),
      contractAddress: /^0x[a-fA-F0-9]{40}$/.test(t.id) ? t.id : null,
    }));
  }

  /**
   * Sum up supply/borrow USD across every DeFi protocol the address
   * participates in. One DeBank credit per call. Returns zeroed result
   * (not error) on missing fields so a partial response from DeBank
   * doesn't fail the whole refresh.
   */
  async getProtocolsSummary(address: string): Promise<DebankProtocolsSummary> {
    if (!this.isLive) throw new ProviderNotConfiguredError("debank");
    const url = new URL(`${this.base}/v1/user/all_complex_protocol_list`);
    url.searchParams.set("id", address);
    const body = await this.fetchJson<DeBankComplexProtocol[]>(url);

    let asset = 0;
    let debt = 0;
    const supplyTokens: Array<{
      symbol: string;
      amount: number;
      priceUsd: number;
      chain: string;
    }> = [];
    const protocols: Array<{
      id: string;
      chain: string;
      name: string;
      assetUsd: number;
      debtUsd: number;
      supplyTokens: Array<{ symbol: string; amount: number; priceUsd: number }>;
      debtTokens: Array<{ symbol: string; amount: number; priceUsd: number }>;
    }> = [];
    for (const proto of body) {
      let protoAsset = 0;
      let protoDebt = 0;
      const protoSupplies: Array<{ symbol: string; amount: number; priceUsd: number }> = [];
      const protoDebts: Array<{ symbol: string; amount: number; priceUsd: number }> = [];
      // Some protocols expose top-level asset/debt; others only the
      // portfolio_item_list breakdown. Prefer the granular path because
      // it's authoritative; fall back to top-level for protocols that
      // don't ship it (e.g. CEX integrations).
      if (proto.portfolio_item_list && proto.portfolio_item_list.length > 0) {
        for (const item of proto.portfolio_item_list) {
          protoAsset += Number(item.stats?.asset_usd_value ?? 0);
          protoDebt += Number(item.stats?.debt_usd_value ?? 0);
          const supplies = item.detail?.supply_token_list ?? [];
          for (const t of supplies) {
            const amount = Number(t.amount ?? 0);
            const price = Number(t.price ?? 0);
            if (!t.symbol || amount <= 0 || price <= 0) continue;
            supplyTokens.push({
              symbol: t.symbol,
              amount,
              priceUsd: price,
              chain: t.chain,
            });
            protoSupplies.push({ symbol: t.symbol, amount, priceUsd: price });
          }
          const borrows = item.detail?.borrow_token_list ?? [];
          for (const t of borrows) {
            const amount = Number(t.amount ?? 0);
            const price = Number(t.price ?? 0);
            if (!t.symbol || amount <= 0 || price <= 0) continue;
            protoDebts.push({ symbol: t.symbol, amount, priceUsd: price });
          }
        }
      } else {
        protoAsset = Number(proto.asset_usd_value ?? 0);
        protoDebt = Number(proto.debt_usd_value ?? 0);
      }
      asset += protoAsset;
      debt += protoDebt;
      if (protoAsset > 0 || protoDebt > 0) {
        protocols.push({
          id: proto.id,
          chain: proto.chain,
          name: proto.name ?? proto.id,
          assetUsd: protoAsset,
          debtUsd: protoDebt,
          supplyTokens: protoSupplies,
          debtTokens: protoDebts,
        });
      }
    }
    return {
      protocolsAssetUsd: asset,
      totalDebtUsd: debt,
      protocolsCount: protocols.length,
      supplyTokens,
      protocols,
    };
  }

  /**
   * IBalanceProvider contract — DeBank queries by address across all
   * chains in a single call. We filter by the requested chainId.
   */
  async getWalletBalances(
    chainId: number,
    address: string
  ): Promise<BalanceEntry[]> {
    const chainSlug = debankChainSlug(chainId);
    if (!chainSlug) return [];
    const tokens = await this.getAllTokens(address);
    return tokens
      .filter((t) => t.chain === chainSlug)
      .map((t) => ({
        symbol: t.symbol.toUpperCase(),
        amount: t.amount.toString(),
        chainId,
        contractAddress: t.contractAddress,
      }));
  }

  /**
   * Fetch the full address history with paginated cursor `start_time`
   * over `/v1/user/all_history_list`. DeBank caps each page at ~20 tx;
   * we walk pages until: empty page, partial page, or `maxPages`.
   *
   * Dictionaries (`token_dict`, `project_dict`, `cex_dict`) are merged
   * across all pages; duplicate tx ids are de-duped.
   *
   * **Cost**: 1 DeBank credit per page. With default maxPages=10 that
   * caps a per-address call at 10 credits. Per-user rate-limit (S2) on
   * the upstream-proxy gives a second ceiling.
   */
  async getHistory(
    address: string,
    opts: GetHistoryOptions = {}
  ): Promise<DeBankHistoryBundle> {
    if (!this.isLive) throw new ProviderNotConfiguredError("debank");
    const maxPages = opts.maxPages ?? 10;
    const pageCount = 20;

    const history_list: DeBankHistoryBundle["history_list"] = [];
    const seenIds = new Set<string>();
    const token_dict: Record<string, unknown> = {};
    const project_dict: Record<string, unknown> = {};
    const cex_dict: Record<string, unknown> = {};

    let startTime: number | undefined = undefined;
    let lastSeenTime = Number.POSITIVE_INFINITY;

    for (let p = 0; p < maxPages; p++) {
      const url = new URL(`${this.base}/v1/user/all_history_list`);
      url.searchParams.set("id", address.toLowerCase());
      url.searchParams.set("page_count", String(pageCount));
      if (opts.chainIds) url.searchParams.set("chain_ids", opts.chainIds);
      if (startTime !== undefined) {
        url.searchParams.set("start_time", String(startTime));
      }

      const page = await this.fetchJson<DeBankHistoryBundle>(url);
      Object.assign(token_dict, page.token_dict ?? {});
      Object.assign(project_dict, page.project_dict ?? {});
      Object.assign(cex_dict, page.cex_dict ?? {});

      const items = page.history_list ?? [];
      for (const it of items) {
        if (seenIds.has(it.id)) continue;
        seenIds.add(it.id);
        history_list.push(it);
      }

      if (items.length === 0) break;
      if (items.length < pageCount) break;

      const tail = items[items.length - 1]!;
      // Defensive: if the API stops moving the cursor we'd loop forever.
      if (tail.time_at >= lastSeenTime) break;
      lastSeenTime = tail.time_at;
      startTime = tail.time_at;
    }

    return { history_list, token_dict, project_dict, cex_dict };
  }

  private async fetchJson<T>(url: URL): Promise<T> {
    const res = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
        AccessKey: this.apiKey ?? "",
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "<no body>");
      throw new ProviderError(
        `DeBank ${res.status} ${res.statusText} — ${text.slice(0, 200)}`,
        "debank",
        res.status
      );
    }
    return (await res.json()) as T;
  }
}

function debankChainSlug(chainId: number): string | null {
  switch (chainId) {
    case 1:
      return "eth";
    case 10:
      return "op";
    case 56:
      return "bsc";
    case 137:
      return "matic";
    case 8453:
      return "base";
    case 42161:
      return "arb";
    case 43114:
      return "avax";
    default:
      return null;
  }
}
