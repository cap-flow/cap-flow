import { describe, expect, it } from "vitest";

import { isTrustworthyCostBasis } from "./liquidity_events";

/**
 * Regression guard for the MMaksimuk POS-024 prod incident (2026-05-29).
 *
 * The Velodrome NFT cached as `{netCostBasisUsd:0, hasHistPrices:false}` while
 * the prod `/defillama` proxy was returning SPA HTML. After the proxy was
 * fixed the stale entry was still served from cache, permanently pinning a $0
 * cost basis. A cached result must only be trusted (and re-persisted) when it
 * actually resolved historical prices.
 */
describe("isTrustworthyCostBasis", () => {
  it("rejects an entry priced during a feed outage (hasHistPrices=false)", () => {
    // Exact shape of the poisoned prod cache entry.
    expect(
      isTrustworthyCostBasis({ hasHistPrices: false }),
    ).toBe(false);
  });

  it("accepts an entry that resolved historical prices", () => {
    expect(isTrustworthyCostBasis({ hasHistPrices: true })).toBe(true);
  });
});
