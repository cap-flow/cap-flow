import {
  type IPriceProvider,
  type PriceQuote,
  ProviderError,
} from "./types.js";

/**
 * CoinGecko price client.
 *
 * Free tier (~10–50 req/min) requires no key; passing one switches to the
 * pro endpoint. We don't ship any retry logic here — the cache + quota
 * wrapper above us absorbs most flakiness, and a 429 should propagate to
 * the caller so the api_usage log captures it.
 */
export class CoinGeckoClient implements IPriceProvider {
  readonly name = "coingecko" as const;
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string | undefined,
    baseUrlOverride?: string
  ) {
    this.baseUrl =
      baseUrlOverride ??
      (apiKey ? "https://pro-api.coingecko.com/api/v3" : "https://api.coingecko.com/api/v3");
  }

  async getPrice(symbol: string, coingeckoId: string): Promise<PriceQuote> {
    const url = new URL(`${this.baseUrl}/simple/price`);
    url.searchParams.set("ids", coingeckoId);
    url.searchParams.set("vs_currencies", "usd");
    url.searchParams.set("include_last_updated_at", "true");

    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) headers["x-cg-pro-api-key"] = this.apiKey;

    const res = await fetch(url.toString(), { headers });
    if (!res.ok) {
      throw new ProviderError(
        `CoinGecko ${res.status} ${res.statusText}`,
        "coingecko",
        res.status
      );
    }

    const body = (await res.json()) as Record<
      string,
      { usd?: number; last_updated_at?: number }
    >;
    const entry = body[coingeckoId];
    if (!entry || typeof entry.usd !== "number") {
      throw new ProviderError(
        `CoinGecko returned no usd price for '${coingeckoId}'`,
        "coingecko"
      );
    }

    return {
      symbol: symbol.toUpperCase(),
      priceUsd: entry.usd,
      fetchedAt: entry.last_updated_at
        ? new Date(entry.last_updated_at * 1000).toISOString()
        : new Date().toISOString(),
      source: "coingecko",
    };
  }
}
