/**
 * B5 loader — pure mapping (chain_operations rows → UcbComputeWallet).
 * The drizzle plumbing is thin/untested (codebase style); the R13 filter +
 * chain mapping + SavedWallet construction live in a pure function, tested here.
 */
import { describe, expect, it } from "vitest";

import {
  rowsToComputeWallet,
  toWalletChain,
} from "./ucb-ops.repository.js";
import { computePositions, type OpPriceSource } from "./ucb.service.js";

const stubPricing: OpPriceSource = {
  priceMapForOps: async () => ({ histPrices: new Map(), missing: [] }),
};

const opRow = (over: Record<string, unknown>, status = "ok") => ({
  status,
  raw: { type: "swap", time: 1000, chain: "arb", status: "ok", movement: [], ...over },
});

describe("toWalletChain", () => {
  it("maps address type → engine WalletChain", () => {
    expect(toWalletChain("evm")).toBe("evm");
    expect(toWalletChain("solana")).toBe("sol");
    expect(toWalletChain("tron")).toBe("coinstats");
    expect(toWalletChain("btc")).toBe("coinstats");
  });
});

describe("rowsToComputeWallet (B5 loader core)", () => {
  const wallet = {
    id: "w1",
    name: "EVM cold",
    createdAt: new Date("2026-01-02T03:04:05.000Z"),
  };

  it("returns null when the wallet has no address", () => {
    expect(
      rowsToComputeWallet({ wallet, address: null, opRows: [] }),
    ).toBeNull();
  });

  it("builds SavedWallet with ms createdAt + mapped chain", () => {
    const cw = rowsToComputeWallet({
      wallet,
      address: { address: "0xabc", type: "evm" },
      opRows: [],
    })!;
    expect(cw.wallet).toEqual({
      id: "w1",
      name: "EVM cold",
      address: "0xabc",
      chain: "evm",
      createdAt: Date.parse("2026-01-02T03:04:05.000Z"),
    });
    expect(typeof cw.wallet.createdAt).toBe("number");
  });

  it("R13: drops failed ops (column status AND raw.status), keeps order + passthrough", () => {
    const opRows = [
      opRow({ time: 100, hash: "0xA" }),
      opRow({ time: 200, hash: "0xB", status: "failed" }), // raw.status failed
      { status: "failed", raw: { type: "swap", time: 300, hash: "0xC", status: "ok" } }, // column failed
      opRow({ time: 400, hash: "0xD" }),
    ];
    const cw = rowsToComputeWallet({
      wallet,
      address: { address: "0xabc", type: "evm" },
      opRows,
    })!;
    expect(cw.ops.map((o) => (o as { hash: string }).hash)).toEqual(["0xA", "0xD"]);
    // raw passes through unchanged
    expect(cw.ops[0]).toEqual(opRows[0]!.raw);
  });

  it("output is engine-consumable (feeds computePositions without error)", async () => {
    const cw = rowsToComputeWallet({
      wallet,
      address: { address: "0xabc", type: "evm" },
      opRows: [opRow({ time: 100, hash: "0xA" })],
    })!;
    const positions = await computePositions([cw], {
      opPricingService: stubPricing,
    });
    expect(Array.isArray(positions)).toBe(true);
  });
});
