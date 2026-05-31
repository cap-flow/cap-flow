/**
 * UCB methodology differentiation (2026-05-31): FIFO/LIFO/WAC/HIFO must produce
 * DIFFERENT cost for a PARTIAL consume of a multi-lot pool. Locks the engine
 * after the Lot-toggle fix (methodology threaded through buildOne). Guards the
 * "FIFO == LIFO" question: they coincide only on FULL-pool consumption (order
 * irrelevant when you take everything) — not on partial.
 */
import { describe, expect, it } from "vitest";

import { LotTracker } from "./lot_tracker";
import type { LotMethodology } from "./types";

function poolCost(m: LotMethodology, consumeAmount: number): number {
  const t = new LotTracker(m);
  const base = {
    symbol: "ETH",
    tokenId: "eth",
    chain: "eth",
    walletId: "w1",
    acquiredVia: "swap" as const,
  };
  // 3 lots, distinct prices, chronological (old→new).
  t.acquire({ ...base, amount: 4, costPerUnitUsd: 1000, acquiredAt: 100, sourceHash: "0xa" });
  t.acquire({ ...base, amount: 4, costPerUnitUsd: 2000, acquiredAt: 200, sourceHash: "0xb" });
  t.acquire({ ...base, amount: 4, costPerUnitUsd: 3000, acquiredAt: 300, sourceHash: "0xc" });
  return t.consume({ symbol: "ETH", chain: "eth", walletId: "w1", amount: consumeAmount })
    .totalCostUsd;
}

describe("lot methodology differentiation", () => {
  it("PARTIAL consume (6 of 12) → FIFO/LIFO/WAC/HIFO all differ", () => {
    expect(poolCost("FIFO", 6)).toBeCloseTo(8000, 6); // oldest cheap: 4@1000 + 2@2000
    expect(poolCost("LIFO", 6)).toBeCloseTo(16000, 6); // newest dear: 4@3000 + 2@2000
    expect(poolCost("WAC", 6)).toBeCloseTo(12000, 6); // avg $2000 × 6
    expect(poolCost("HIFO", 6)).toBeCloseTo(16000, 6); // highest cost first
    // FIFO must NOT equal LIFO on partial consume (the bug we ruled out).
    expect(poolCost("FIFO", 6)).not.toBeCloseTo(poolCost("LIFO", 6), 1);
  });

  it("FULL consume (all 12) → FIFO == LIFO == WAC (order irrelevant)", () => {
    // Σ = 4×1000 + 4×2000 + 4×3000 = 24000. This is WHY live lending positions
    // with partial coverage show FIFO==LIFO: they consume the whole traced pool.
    expect(poolCost("FIFO", 12)).toBeCloseTo(24000, 6);
    expect(poolCost("LIFO", 12)).toBeCloseTo(24000, 6);
    expect(poolCost("WAC", 12)).toBeCloseTo(24000, 6);
  });
});
