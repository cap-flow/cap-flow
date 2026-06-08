/**
 * Epic C / C5b — duplicate_op_divergent_pricing pure check tests (offline).
 */
import { describe, it, expect } from "vitest";

import {
  findDivergentDuplicatePricing,
  findSwapMovementImbalance,
  type OpPriceRecord,
  type SwapOpRecord,
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

function swap(over: Partial<SwapOpRecord>): SwapOpRecord {
  return {
    chain: "eth",
    txHash: "0xabc",
    logIndex: 0,
    walletId: "w1",
    accountId: "a1",
    outUsd: 100,
    inUsd: 100,
    ...over,
  };
}

describe("swap_movement_imbalance", () => {
  it("does NOT flag a balanced swap", () => {
    expect(
      findSwapMovementImbalance([swap({ outUsd: 100, inUsd: 100 })]),
    ).toEqual([]);
  });

  it("does NOT flag within 20% threshold", () => {
    expect(
      findSwapMovementImbalance([swap({ outUsd: 100, inUsd: 85 })]), // 15%
    ).toEqual([]);
  });

  it("flags warn when out $100 vs in $50 (50% imbalance)", () => {
    const f = findSwapMovementImbalance([swap({ outUsd: 100, inUsd: 50 })]);
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warn");
    expect(f[0]!.checkId).toBe("swap_movement_imbalance");
    expect(f[0]!.phase).toBe("pre");
    expect(f[0]!.observedValue).toBeCloseTo(0.5, 5);
    expect(f[0]!.detail.outUsd).toBe(100);
    expect(f[0]!.detail.inUsd).toBe(50);
    expect(f[0]!.detail.imbalancePct as number).toBeCloseTo(50, 5);
  });

  it("flags the 0xe99d6063-shaped case (out $12k vs in $5.6k)", () => {
    const f = findSwapMovementImbalance([
      swap({ outUsd: 12000, inUsd: 5600 }),
    ]);
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warn");
  });

  it("flags aida POS-001 swap 0x91c5dcb9 (out 719.11 USDC vs in 513.50 WETH = 28.6%)", () => {
    // Аудит aida 2026-06-08: DeBank недооценил WETH ($1686 vs implied $2360) →
    // out/in разъехались на 28.6% — это был тычок к багу cost basis. Чек ловит
    // именно этот mispriced-swap класс (audit-lead). NB: balanced unwrap
    // WETH→ETH (0%, где cost реально терялся) этим чеком НЕ ловится — его берёт
    // cost_basis_from_spot (priceSource=fallback).
    const f = findSwapMovementImbalance([
      swap({ txHash: "0x91c5dcb9", outUsd: 719.11, inUsd: 513.5 }),
    ]);
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warn");
    expect(f[0]!.observedValue as number).toBeCloseTo(0.286, 2);
  });

  it("ignores dust swaps below minUsd", () => {
    expect(
      findSwapMovementImbalance([swap({ outUsd: 0.8, inUsd: 0.2 })]),
    ).toEqual([]);
  });

  it("is deterministic — sorts findings by (chain,txHash,logIndex)", () => {
    const f = findSwapMovementImbalance([
      swap({ txHash: "0xbbb", logIndex: 0, outUsd: 100, inUsd: 10 }),
      swap({ txHash: "0xaaa", logIndex: 0, outUsd: 100, inUsd: 10 }),
    ]);
    expect(f).toHaveLength(2);
    expect(f[0]!.detail.txHash).toBe("0xaaa");
    expect(f[1]!.detail.txHash).toBe("0xbbb");
  });
});
