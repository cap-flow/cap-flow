/**
 * Epic C / C5b — duplicate_op_divergent_pricing pure check tests (offline).
 */
import { describe, it, expect } from "vitest";

import {
  findDivergentDuplicatePricing,
  type OpPriceRecord,
} from "./registry_checks.js";

function rec(over: Partial<OpPriceRecord>): OpPriceRecord {
  return {
    chain: "eth",
    txHash: "0xabc",
    logIndex: 0,
    walletId: "w1",
    accountId: "a1",
    usd: 100,
    ...over,
  };
}

describe("duplicate_op_divergent_pricing", () => {
  it("flags error when same event diverges >5% across two wallets", () => {
    const f = findDivergentDuplicatePricing([
      rec({ walletId: "w1", accountId: "a1", usd: 100 }),
      rec({ walletId: "w2", accountId: "a2", usd: 75 }), // 25% spread
    ]);
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("error");
    expect(f[0]!.detail.crossAccount).toBe(true);
    expect((f[0]!.detail.spreadPct as number)).toBeCloseTo(25, 5);
  });

  it("flags warn between 1% and 5%", () => {
    const f = findDivergentDuplicatePricing([
      rec({ walletId: "w1", usd: 100 }),
      rec({ walletId: "w2", usd: 97 }), // 3%
    ]);
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warn");
  });

  it("does NOT flag within 1% (deterministic-enough)", () => {
    expect(
      findDivergentDuplicatePricing([
        rec({ walletId: "w1", usd: 100 }),
        rec({ walletId: "w2", usd: 99.5 }),
      ]),
    ).toEqual([]);
  });

  it("does NOT flag when the divergence is within ONE wallet", () => {
    // same wallet, two rows (e.g. re-sync) — not a cross-wallet integrity issue
    expect(
      findDivergentDuplicatePricing([
        rec({ walletId: "w1", usd: 100 }),
        rec({ walletId: "w1", usd: 60 }),
      ]),
    ).toEqual([]);
  });

  it("ignores dust rows below minUsd", () => {
    expect(
      findDivergentDuplicatePricing([
        rec({ walletId: "w1", usd: 0.5 }),
        rec({ walletId: "w2", usd: 0.2 }),
      ]),
    ).toEqual([]);
  });

  it("separates distinct events by (chain,txHash,logIndex)", () => {
    const f = findDivergentDuplicatePricing([
      rec({ txHash: "0xa", logIndex: 0, walletId: "w1", usd: 100 }),
      rec({ txHash: "0xa", logIndex: 0, walletId: "w2", usd: 50 }), // group 1: 50%
      rec({ txHash: "0xa", logIndex: 1, walletId: "w1", usd: 100 }),
      rec({ txHash: "0xa", logIndex: 1, walletId: "w2", usd: 100 }), // group 2: 0%
    ]);
    expect(f).toHaveLength(1);
    expect(f[0]!.detail.logIndex).toBe(0);
  });

  it("is case-insensitive on txHash and order-stable", () => {
    const a = findDivergentDuplicatePricing([
      rec({ txHash: "0xABC", walletId: "w1", usd: 100 }),
      rec({ txHash: "0xabc", walletId: "w2", usd: 70 }),
    ]);
    expect(a).toHaveLength(1); // same group despite case
  });
});
