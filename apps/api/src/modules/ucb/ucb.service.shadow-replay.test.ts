/**
 * B5 keystone proof: the SERVER computes the SAME numbers as the client.
 *
 * Feeds frozen golden fixtures (the exact `ReplayInput` the client's dev-hook
 * exported) into the server `computePositions` and asserts each anchored
 * position's startUsd deep-equals the client-verified value. Fully offline:
 * `OpPriceSource` is a stub returning the fixture's frozen histPrices (no DB,
 * no DefiLlama). This proves the canonical `@cap-flow/ucb` engine reproduces a
 * golden anchor server-side — the north star of the UCB port.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  computePositions,
  type OpPriceSource,
  type UcbComputeWallet,
} from "./ucb.service.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadFixture(name: string): any {
  return JSON.parse(
    readFileSync(
      new URL(`./__fixtures__/ucb-shadow/${name}`, import.meta.url),
      "utf8",
    ),
  );
}

/** Frozen B1 price source — returns the fixture's captured histPrices, no DB. */
function stubPricing(entries: [string, number][]): OpPriceSource {
  const histPrices = new Map<string, number>(entries);
  return {
    priceMapForOps: async () => ({ histPrices, missing: [] }),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function run(fixture: any) {
  return computePositions(fixture.input.wallets as UcbComputeWallet[], {
    opPricingService: stubPricing(fixture.input.histPrices ?? []),
    lotMethodology: fixture.lotMethodology,
  });
}

describe("ucb.service computePositions — B5 server/client parity (shadow)", () => {
  it("synthetic Aave lending: startUsd = cost basis $2000, not $3000 spot", async () => {
    const fx = loadFixture("simple-aave-eth.json");
    const positions = await run(fx);
    const p = positions.find((x) => x.protocol.id === "eth_aave3");
    expect(p, "aave position computed server-side").toBeDefined();
    // The whole point: cost basis ($2000 paid), not current spot ($3000).
    expect(Math.abs(p!.startUsd - 2000)).toBeLessThanOrEqual(0.01);
  });

  it("real testakk Fluid WBTC: server reproduces the client startUsd $1068.53", async () => {
    const fx = loadFixture("murat-1.json");
    const positions = await run(fx);
    const p = positions.find(
      (x) =>
        /fluid/i.test(x.protocol.id) && x.supplyTokens[0]?.symbol === "WBTC",
    );
    expect(p, "fluid WBTC position computed server-side").toBeDefined();
    // Golden anchor: $1068.53 (registry-verified LIFO/paid-cost). ±$1 / 0.5%.
    const expected = 1068.53;
    expect(Math.abs(p!.startUsd - expected)).toBeLessThanOrEqual(
      Math.max(1, expected * 0.005),
    );
  });

  it("task #18: lending startUsd honors the FIFO/LIFO/WAC toggle (artur ETH Fluid)", async () => {
    const fx = loadFixture("artur-1.json");
    const ethLeg = (positions: Awaited<ReturnType<typeof computePositions>>) =>
      positions.find(
        (x) => /fluid/i.test(x.protocol.id) && x.supplyTokens[0]?.symbol === "ETH",
      );

    // The bug: computePositions dropped the methodology when calling
    // buildOpenPositions, so buildSupplyToken fell back to "WAC" and the toggle
    // was inert server-side ($33,708 under FIFO *and* LIFO *and* WAC), diverging
    // +4.4% from the client whenever the user picked LIFO.
    const lifo = ethLeg(
      await computePositions(fx.input.wallets as UcbComputeWallet[], {
        opPricingService: stubPricing(fx.input.histPrices ?? []),
        lotMethodology: "LIFO",
      }),
    );
    const wac = ethLeg(
      await computePositions(fx.input.wallets as UcbComputeWallet[], {
        opPricingService: stubPricing(fx.input.histPrices ?? []),
        lotMethodology: "WAC",
      }),
    );
    expect(lifo, "artur ETH Fluid leg computed").toBeDefined();
    expect(wac, "artur ETH Fluid leg computed").toBeDefined();

    // The toggle still flows through to the supply-token cost basis: LIFO ≠ WAC.
    expect(Math.abs(lifo!.startUsd - wac!.startUsd)).toBeGreaterThan(100);
    // CORRECTED 2026-06-08 (aida POS-001 token→token unwrap fix): values dropped
    // from LIFO $32,296.72 / WAC $33,708.57 because WETH (returned by lp_remove
    // with real LP-attributed cost) → ETH swap no longer resets cost to market
    // spot — it inherits the consumed lot cost (position_lot_cost_basis.ts).
    expect(Math.abs(lifo!.startUsd - 30953.89)).toBeLessThanOrEqual(1);
    expect(Math.abs(wac!.startUsd - 32773.02)).toBeLessThanOrEqual(1);
  });

  it("deterministic (R4): identical inputs → byte-identical output", async () => {
    const fx = loadFixture("murat-1.json");
    const a = await run(fx);
    const b = await run(fx);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
