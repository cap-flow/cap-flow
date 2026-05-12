/**
 * Self-check сценарии для LotTracker / PositionTracker.
 *
 * Используется для верификации регрессий вручную или из browser console:
 *   window.capflowSelfCheck()
 *
 * Каждый scenario описывает:
 *   - входные ops (synthetic)
 *   - ожидаемый output (cost basis, position state)
 *   - automatic check
 *
 * Эти проверки эквивалентны unit-тестам, но не требуют тест-фреймворка.
 */

import { LotTracker } from "./lot_tracker";

interface SelfCheckResult {
  scenario: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
  message?: string;
}

function approxEqual(a: number, b: number, tolerance = 0.01): boolean {
  return Math.abs(a - b) < tolerance;
}

const ALICE = "alice-wallet";
const HASH = (i: number) => `0x${"a".repeat(63)}${i}`;

// ─── Scenarios ──────────────────────────────────────────────────────────

function scenarioBasicWAC(): SelfCheckResult {
  const lots = new LotTracker("WAC");
  // Buy 1 ETH @ $2000
  lots.acquire({
    symbol: "ETH", tokenId: "0x0", chain: "eth", amount: 1,
    costPerUnitUsd: 2000, acquiredAt: 1000, acquiredVia: "buy_with_stable",
    sourceHash: HASH(1), walletId: ALICE,
  });
  // Buy 2 ETH @ $3000
  lots.acquire({
    symbol: "ETH", tokenId: "0x0", chain: "eth", amount: 2,
    costPerUnitUsd: 3000, acquiredAt: 2000, acquiredVia: "buy_with_stable",
    sourceHash: HASH(2), walletId: ALICE,
  });
  // WAC should be (1×2000 + 2×3000) / 3 = $2666.67
  const wac = lots.currentWac(ALICE, "ETH");
  return {
    scenario: "basic WAC: 1 ETH @ $2000 + 2 ETH @ $3000 → $2666.67",
    expected: 2666.67,
    actual: wac,
    passed: wac != null && approxEqual(wac, 2666.67, 1),
  };
}

function scenarioConsumeWAC(): SelfCheckResult {
  const lots = new LotTracker("WAC");
  lots.acquire({
    symbol: "ETH", tokenId: "0x0", chain: "eth", amount: 1,
    costPerUnitUsd: 2000, acquiredAt: 1000, acquiredVia: "buy_with_stable",
    sourceHash: HASH(1), walletId: ALICE,
  });
  lots.acquire({
    symbol: "ETH", tokenId: "0x0", chain: "eth", amount: 2,
    costPerUnitUsd: 3000, acquiredAt: 2000, acquiredVia: "buy_with_stable",
    sourceHash: HASH(2), walletId: ALICE,
  });
  // Consume 1.5 ETH → totalCost = ?
  // FIFO order (default array order): take 1 from first lot ($2000),
  // 0.5 from second ($1500). Total $3500.
  const result = lots.consume({
    symbol: "ETH", amount: 1.5, consumedAt: 3000, walletId: ALICE,
  });
  return {
    scenario: "consume 1.5 ETH (FIFO order on lots): cost $3500",
    expected: 3500,
    actual: result.totalCostUsd,
    passed: approxEqual(result.totalCostUsd, 3500, 1),
  };
}

function scenarioCrossProtocolGLV(): SelfCheckResult {
  const lots = new LotTracker("WAC");
  // Acquire 1000 GLV via 4 GMX V2 deposits (cumulative cost $1500).
  lots.acquire({
    symbol: "GLV", tokenId: "0x528a", chain: "arb", amount: 250,
    costPerUnitUsd: 1.5, acquiredAt: 1000, acquiredVia: "linked_async_fill",
    sourceHash: HASH(1), walletId: ALICE,
  });
  lots.acquire({
    symbol: "GLV", tokenId: "0x528a", chain: "arb", amount: 250,
    costPerUnitUsd: 1.5, acquiredAt: 2000, acquiredVia: "linked_async_fill",
    sourceHash: HASH(2), walletId: ALICE,
  });
  lots.acquire({
    symbol: "GLV", tokenId: "0x528a", chain: "arb", amount: 250,
    costPerUnitUsd: 1.5, acquiredAt: 3000, acquiredVia: "linked_async_fill",
    sourceHash: HASH(3), walletId: ALICE,
  });
  lots.acquire({
    symbol: "GLV", tokenId: "0x528a", chain: "arb", amount: 250,
    costPerUnitUsd: 1.5, acquiredAt: 4000, acquiredVia: "linked_async_fill",
    sourceHash: HASH(4), walletId: ALICE,
  });
  // Now consume 1000 GLV (full position) into Morpho as collateral.
  // Cost should be 1000 × $1.5 = $1500.
  const result = lots.consume({
    symbol: "GLV", amount: 1000, consumedAt: 5000, walletId: ALICE,
  });
  return {
    scenario: "cross-protocol GLV: 4× $375 deposits → 1000 GLV → $1500 consumed cost",
    expected: 1500,
    actual: result.totalCostUsd,
    passed: approxEqual(result.totalCostUsd, 1500, 1),
  };
}

function scenarioPartialThenAdd(): SelfCheckResult {
  const lots = new LotTracker("WAC");
  // Pattern: 100 GLV @ $1.5 (cost $150) → consume 30 GLV ($45) → add 50 GLV @ $2 ($100)
  lots.acquire({
    symbol: "GLV", tokenId: "0x528a", chain: "arb", amount: 100,
    costPerUnitUsd: 1.5, acquiredAt: 1000, acquiredVia: "linked_async_fill",
    sourceHash: HASH(1), walletId: ALICE,
  });
  const consumed = lots.consume({
    symbol: "GLV", amount: 30, consumedAt: 2000, walletId: ALICE,
  });
  if (!approxEqual(consumed.totalCostUsd, 45, 0.01)) {
    return {
      scenario: "partial+add",
      expected: 45,
      actual: consumed.totalCostUsd,
      passed: false,
      message: "first consume cost should be $45",
    };
  }
  lots.acquire({
    symbol: "GLV", tokenId: "0x528a", chain: "arb", amount: 50,
    costPerUnitUsd: 2, acquiredAt: 3000, acquiredVia: "linked_async_fill",
    sourceHash: HASH(2), walletId: ALICE,
  });
  // Now have 70 + 50 = 120 GLV with $105 + $100 = $205 total cost.
  // WAC = $205/120 = $1.708
  const wac = lots.currentWac(ALICE, "GLV");
  return {
    scenario: "partial consume + add: WAC after = $1.708",
    expected: 1.708,
    actual: wac,
    passed: wac != null && approxEqual(wac, 1.708, 0.01),
  };
}

function scenarioBorrowZeroCost(): SelfCheckResult {
  const lots = new LotTracker("WAC");
  // Borrow 1000 USDC: lot with cost = 0
  lots.acquire({
    symbol: "USDC", tokenId: "0xaf88", chain: "arb", amount: 1000,
    costPerUnitUsd: 0, acquiredAt: 1000, acquiredVia: "borrow",
    sourceHash: HASH(1), walletId: ALICE,
  });
  const wac = lots.currentWac(ALICE, "USDC");
  return {
    scenario: "borrow 1000 USDC: WAC = $0/USDC (это занятые средства)",
    expected: 0,
    actual: wac,
    passed: wac === 0,
  };
}

function scenarioEmptyWallet(): SelfCheckResult {
  const lots = new LotTracker("WAC");
  const result = lots.consume({
    symbol: "ETH", amount: 1, consumedAt: 1000, walletId: ALICE,
  });
  return {
    scenario: "consume from empty wallet: insufficient",
    expected: { totalCost: 0, insufficient: true },
    actual: { totalCost: result.totalCostUsd, insufficient: result.insufficient },
    passed: result.totalCostUsd === 0 && result.insufficient === true,
  };
}

function scenarioMultiWalletIsolation(): SelfCheckResult {
  const lots = new LotTracker("WAC");
  const BOB = "bob-wallet";
  lots.acquire({
    symbol: "ETH", tokenId: "0x0", chain: "eth", amount: 1,
    costPerUnitUsd: 2000, acquiredAt: 1000, acquiredVia: "buy_with_stable",
    sourceHash: HASH(1), walletId: ALICE,
  });
  lots.acquire({
    symbol: "ETH", tokenId: "0x0", chain: "eth", amount: 2,
    costPerUnitUsd: 5000, acquiredAt: 2000, acquiredVia: "buy_with_stable",
    sourceHash: HASH(2), walletId: BOB,
  });
  const aliceWac = lots.currentWac(ALICE, "ETH");
  const bobWac = lots.currentWac(BOB, "ETH");
  return {
    scenario: "Alice WAC=$2000, Bob WAC=$5000 (isolation by walletId)",
    expected: { aliceWac: 2000, bobWac: 5000 },
    actual: { aliceWac, bobWac },
    passed:
      aliceWac != null && bobWac != null &&
      approxEqual(aliceWac, 2000, 1) && approxEqual(bobWac, 5000, 1),
  };
}

// ─── Runner ─────────────────────────────────────────────────────────────

const SCENARIOS: Array<() => SelfCheckResult> = [
  scenarioBasicWAC,
  scenarioConsumeWAC,
  scenarioCrossProtocolGLV,
  scenarioPartialThenAdd,
  scenarioBorrowZeroCost,
  scenarioEmptyWallet,
  scenarioMultiWalletIsolation,
];

export function runLotsSelfCheck(): {
  total: number;
  passed: number;
  failed: number;
  results: SelfCheckResult[];
} {
  const results = SCENARIOS.map((s) => {
    try {
      return s();
    } catch (e) {
      return {
        scenario: s.name,
        passed: false,
        expected: "no error",
        actual: String(e),
      };
    }
  });
  return {
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    results,
  };
}

// Expose globally для browser console.
if (typeof window !== "undefined") {
  (window as unknown as { capflowSelfCheck: typeof runLotsSelfCheck })
    .capflowSelfCheck = runLotsSelfCheck;
}
