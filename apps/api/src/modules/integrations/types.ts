/**
 * Provider abstractions. Each upstream service the platform calls implements
 * one or more of these interfaces. Real implementations live alongside.
 *
 * Pattern: the *concrete* clients only know how to call HTTP. The "billing"
 * wrappers in `quoted-provider.ts` add cache, quota, and api_usage logging
 * around them. Routes and other services depend on these interfaces — not
 * concrete classes — so unit tests can swap in mocks.
 */

export type ProviderName =
  | "coingecko"
  | "alchemy"
  | "debank"
  | "etherscan"
  | "helius"
  | "coinstats";

export interface PriceQuote {
  /** Uppercase symbol. */
  readonly symbol: string;
  readonly priceUsd: number;
  /** ISO-8601 timestamp of when the upstream reported this price. */
  readonly fetchedAt: string;
  readonly source: ProviderName;
}

export interface IPriceProvider {
  readonly name: ProviderName;
  /** Fetch one price by symbol. Throws on hard failure. */
  getPrice(symbol: string, coingeckoId: string): Promise<PriceQuote>;
}

export interface BalanceEntry {
  readonly symbol: string;
  readonly amount: string; // decimal string to preserve precision
  readonly chainId: number;
  readonly contractAddress: string | null;
}

export interface IBalanceProvider {
  readonly name: ProviderName;
  getWalletBalances(chainId: number, address: string): Promise<BalanceEntry[]>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: ProviderName,
    public readonly httpStatus?: number
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class ProviderNotConfiguredError extends ProviderError {
  constructor(provider: ProviderName) {
    super(`Provider '${provider}' not configured (missing API key).`, provider);
    this.name = "ProviderNotConfiguredError";
  }
}
