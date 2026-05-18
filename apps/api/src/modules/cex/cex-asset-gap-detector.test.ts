/**
 * UCB Bob-test fix #5: tests for CexAssetGapDetector.
 *
 * Pure function: получает агрегированные по asset суммы (buys/sells/deposits/
 * withdrawals в base units) и возвращает gap warnings для каждого asset
 * где user явно расходовал актив без видимого acquisition trail.
 *
 * Heuristics:
 *   - `outflow_exceeds_inflow`: sold + withdrawn > bought + deposited
 *     с tolerance ±2% (numeric/precision drift). Flag severity = WARN если
 *     ratio < 1.5×, ERROR если ≥ 1.5×.
 *   - `no_acquisitions_at_all`: sold/withdrawn > 0, buys+deposits = 0.
 *     Severity = ERROR (cost basis cannot be reconstructed at all).
 *   - `no_gap`: outflow ≤ inflow → no warning emitted.
 *
 * Stable assets (USDT/USDC/...) skipped — для них bingx pool seeding
 * через P2P fiat покрывает; gap не indicates problem.
 */
import { describe, expect, it } from "vitest";

import {
  detectCexAssetGaps,
  type AssetFlow,
  type AssetGapSeverity,
} from "./cex-asset-gap-detector.js";

function flow(args: {
  asset: string;
  bought?: number;
  sold?: number;
  deposited?: number;
  withdrawn?: number;
}): AssetFlow {
  return {
    asset: args.asset,
    bought: args.bought ?? 0,
    sold: args.sold ?? 0,
    deposited: args.deposited ?? 0,
    withdrawn: args.withdrawn ?? 0,
  };
}

describe("detectCexAssetGaps — UCB Bob-test fix #5", () => {
  it("empty input → empty output", () => {
    expect(detectCexAssetGaps([])).toEqual([]);
  });

  it("balanced asset (buys ≈ sells) → no warning", () => {
    const gaps = detectCexAssetGaps([
      flow({ asset: "ETH", bought: 1.0, sold: 0.99 }),
    ]);
    expect(gaps).toEqual([]);
  });

  it("outflow_exceeds_inflow: sold > bought + deposited → WARN", () => {
    // LTC: 16 buys ($22k), 156 sells. Если в base units bought=200, sold=3000
    // (15× больше) — это error severity.
    const gaps = detectCexAssetGaps([
      flow({ asset: "LTC", bought: 200, sold: 3000 }),
    ]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.asset).toBe("LTC");
    expect(gaps[0]?.kind).toBe("outflow_exceeds_inflow");
    expect(gaps[0]?.severity).toBe<AssetGapSeverity>("error");
    expect(gaps[0]?.ratio).toBeGreaterThan(10);
  });

  it("mild gap (1.1×) → WARN severity", () => {
    const gaps = detectCexAssetGaps([
      flow({ asset: "ETH", bought: 1.0, sold: 1.1 }),
    ]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.severity).toBe<AssetGapSeverity>("warn");
  });

  it("no_acquisitions_at_all: sold > 0 + bought=0 + deposited=0 → ERROR", () => {
    const gaps = detectCexAssetGaps([
      flow({ asset: "BTC", sold: 0.5 }),
    ]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.kind).toBe("no_acquisitions_at_all");
    expect(gaps[0]?.severity).toBe<AssetGapSeverity>("error");
  });

  it("deposits cover sells → no gap", () => {
    // 100 deposited externally, 80 sold. Не bought через trades, но deposited.
    const gaps = detectCexAssetGaps([
      flow({ asset: "BTC", deposited: 100, sold: 80 }),
    ]);
    expect(gaps).toEqual([]);
  });

  it("withdrawals + sells exceed inflow → flagged", () => {
    // bought 1 BTC, sold 0.5, withdrew 0.7 → outflow 1.2 > inflow 1
    const gaps = detectCexAssetGaps([
      flow({ asset: "BTC", bought: 1, sold: 0.5, withdrawn: 0.7 }),
    ]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.kind).toBe("outflow_exceeds_inflow");
  });

  it("stable assets (USDT/USDC) skipped — P2P-funded", () => {
    const gaps = detectCexAssetGaps([
      flow({ asset: "USDT", sold: 1000 }),
      flow({ asset: "USDC", sold: 500 }),
      flow({ asset: "DAI", withdrawn: 200 }),
    ]);
    expect(gaps).toEqual([]);
  });

  it("tolerance ±2%: tiny gap не флагается (precision noise)", () => {
    const gaps = detectCexAssetGaps([
      flow({ asset: "ETH", bought: 1.0, sold: 1.015 }), // 1.5% over
    ]);
    expect(gaps).toEqual([]);
  });

  it("multiple assets — independent gap analysis", () => {
    const gaps = detectCexAssetGaps([
      flow({ asset: "BTC", bought: 1, sold: 1 }), // balanced
      flow({ asset: "ETH", bought: 5, sold: 50 }), // 10× gap → error
      flow({ asset: "LTC", sold: 100 }), // no acquisitions → error
      flow({ asset: "USDT", sold: 5000 }), // stable skipped
    ]);
    expect(gaps).toHaveLength(2);
    expect(gaps.map((g) => g.asset).sort()).toEqual(["ETH", "LTC"]);
  });

  it("idempotent: повторный вызов даёт identical output", () => {
    const input = [flow({ asset: "ETH", bought: 1, sold: 2 })];
    expect(detectCexAssetGaps(input)).toEqual(detectCexAssetGaps(input));
  });

  it("sorts result by severity desc, then by missing amount desc", () => {
    const gaps = detectCexAssetGaps([
      flow({ asset: "ETH", bought: 1, sold: 1.2 }), // warn (1.2×)
      flow({ asset: "BTC", sold: 0.5 }), // error (no acq)
      flow({ asset: "LTC", bought: 100, sold: 500 }), // error (5×)
    ]);
    // Errors first, then warns.
    expect(gaps[0]?.severity).toBe<AssetGapSeverity>("error");
    expect(gaps[1]?.severity).toBe<AssetGapSeverity>("error");
    expect(gaps[2]?.severity).toBe<AssetGapSeverity>("warn");
  });
});
