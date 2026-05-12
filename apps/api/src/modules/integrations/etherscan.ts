import { ProviderNotConfiguredError } from "./types.js";

/**
 * Skeleton Etherscan v2 unified client.
 *
 * Will host the override algorithm for V3 LP cost basis (3-phase: openHash
 * exact match → amount-proximity match → pro-rata fallback). See
 * `notes/decisions/v3-etherscan-cost-basis.md`. Etherscan v2 is the
 * authoritative source for this — DeBank is NOT used here.
 */
export class EtherscanClient {
  readonly name = "etherscan" as const;

  constructor(private readonly apiKey: string | undefined) {}

  async fetchTokenTransfers(): Promise<never> {
    if (!this.apiKey) throw new ProviderNotConfiguredError("etherscan");
    throw new Error("EtherscanClient.fetchTokenTransfers: not implemented yet.");
  }
}
