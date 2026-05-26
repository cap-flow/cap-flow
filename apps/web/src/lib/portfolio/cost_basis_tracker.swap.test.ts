/**
 * Regression: cost basis tracker swap handler (non-stable→non-stable + wrapped tokens).
 *
 * Bug 1 + 2 reproduction from O_lll_ABC_lll_O POS-003 wSPYx audit
 * (2026-05-25):
 *
 *   Op 1: USDC → wSPYx (swap from stable)
 *     → cost basis SPYx: 1000 USDC / 1.4028 wSPYx = $713 / SPYx
 *
 *   Op 2: wSPYx → AUSD (lend_supply, consume)
 *
 *   Op 3: ETH → wSPYx (swap from non-stable)
 *     → раньше: stableSum=0 → buy SKIPPED → 0 cost
 *     → теперь: cost = wacAt(ETH) × 0.041 ETH = $87 (m.usd fallback)
 *
 * Popup "Куплено: SPYx N" должно показать оба buy events.
 */

import { describe, expect, it } from "vitest";

import { buildCostBasisTracker } from "./cost_basis_tracker";
import type { ClassifiedOp, TokenMovement } from "./types";

function mv(args: {
  dir: "in" | "out";
  symbol: string;
  amount: number;
  usd: number | null;
  isStable?: boolean;
}): TokenMovement {
  return {
    direction: args.dir,
    symbol: args.symbol,
    tokenId: args.symbol.toLowerCase(),
    amount: args.amount,
    usd: args.usd,
    isStable: args.isStable ?? false,
    isProtocolToken: false,
  };
}

function op(args: {
  type: ClassifiedOp["type"];
  hash: string;
  time: number;
  movements: TokenMovement[];
}): ClassifiedOp {
  return {
    seq: 0,
    hash: args.hash,
    chain: "eth",
    time: args.time,
    status: "ok",
    type: args.type,
    protocol: null,
    movement: args.movements,
    netUsd: 0,
    gasUsd: null,
    counterparty: null,
    feePayer: null,
    fnName: null,
    approveSpender: null,
    approveSymbol: null,
  };
}

describe("cost basis tracker — swap handler", () => {
  it("Bug 1: ETH → wSPYx (non-stable→non-stable) регистрирует buy (cost = m.usd)", () => {
    const ops: ClassifiedOp[] = [
      // Step 0: get some ETH cost basis. Buy 1 ETH for 2000 USDC.
      op({
        type: "swap",
        hash: "0xbuy_eth",
        time: 1700000000,
        movements: [
          mv({ dir: "out", symbol: "USDC", amount: 2000, usd: 2000, isStable: true }),
          mv({ dir: "in", symbol: "ETH", amount: 1, usd: 2000 }),
        ],
      }),
      // Step 1: swap 0.041 ETH → 0.137 wSPYx
      op({
        type: "swap",
        hash: "0xeth2spyx",
        time: 1700100000,
        movements: [
          mv({ dir: "out", symbol: "ETH", amount: 0.041, usd: 87 }),
          mv({ dir: "in", symbol: "wSPYx", amount: 0.137, usd: 103.68 }),
        ],
      }),
    ];
    const tracker = buildCostBasisTracker(ops);
    // wSPYx → SPYX via normalize. cost: wacAt(ETH)=2000 × 0.041 = $82
    const spyxWac = tracker.avgAt("SPYX", 1700200000);
    expect(spyxWac).not.toBeNull();
    // 0.137 wSPYx with cost $82 → wac = $82/0.137 = $598.5
    expect(spyxWac!).toBeCloseTo(82 / 0.137, 1);
  });

  it("Bug 2: wSPYx → SPYx canonical match через wrap-strip", () => {
    const ops: ClassifiedOp[] = [
      op({
        type: "swap",
        hash: "0x1",
        time: 1700000000,
        movements: [
          mv({ dir: "out", symbol: "USDC", amount: 1000, usd: 1000, isStable: true }),
          mv({ dir: "in", symbol: "wSPYx", amount: 1.402811, usd: 1061.95 }),
        ],
      }),
    ];
    const tracker = buildCostBasisTracker(ops);
    // wSPYx сохраняется в tracker под канонической ключом "SPYX" (strip 'w').
    expect(tracker.avgAt("SPYX", 1700100000)).toBeCloseTo(1000 / 1.402811, 2);
    // wSPYx и SPYx lookup дают одинаковый результат.
    expect(tracker.avgAt("wSPYx", 1700100000)).toBeCloseTo(1000 / 1.402811, 2);
    expect(tracker.avgAt("SPYx", 1700100000)).toBeCloseTo(1000 / 1.402811, 2);
  });

  it("combined POS-003 scenario: USDC→wSPYx + lend_supply + ETH→wSPYx", () => {
    const ops: ClassifiedOp[] = [
      // Step 0: ETH cost basis (нужен для step 3).
      op({
        type: "swap",
        hash: "0xbuy_eth",
        time: 1699999000,
        movements: [
          mv({ dir: "out", symbol: "USDC", amount: 2000, usd: 2000, isStable: true }),
          mv({ dir: "in", symbol: "ETH", amount: 1, usd: 2000 }),
        ],
      }),
      // Step 1: 23.04.2026 USDC→wSPYx
      op({
        type: "swap",
        hash: "0xa",
        time: 1714056000,
        movements: [
          mv({ dir: "out", symbol: "USDC", amount: 1000, usd: 1000, isStable: true }),
          mv({ dir: "in", symbol: "wSPYx", amount: 1.402811, usd: 1061.95 }),
        ],
      }),
      // Step 2: 23.04.2026 lend_supply: wSPYx → AUSD (consume wSPYx).
      op({
        type: "lend_supply",
        hash: "0xb",
        time: 1714056300,
        movements: [
          mv({ dir: "out", symbol: "wSPYx", amount: 1.402811, usd: 1061.95 }),
          mv({ dir: "in", symbol: "AUSD", amount: 815.221506, usd: 815.86, isStable: true }),
        ],
      }),
      // Step 3: 05.05.2026 ETH → wSPYx (non-stable swap)
      op({
        type: "swap",
        hash: "0xc",
        time: 1714999000,
        movements: [
          mv({ dir: "out", symbol: "ETH", amount: 0.041496, usd: 87.02 }),
          mv({ dir: "in", symbol: "wSPYx", amount: 0.13696, usd: 103.68 }),
        ],
      }),
    ];
    const tracker = buildCostBasisTracker(ops);
    // Tracker — cumulative WAC: Σ paid / Σ bought (consume не reset'ит).
    // После step 1: paid=$1000, bought=1.402811 SPYx, wac=$712.85
    // Step 2: lend_supply consume — no-op для WAC
    // После step 3: paid+=wacAt(ETH) × 0.041496 = 2000 × 0.041496 = $82.99
    //   bought+=0.13696 → итого 1.539771
    //   wac = (1000+82.99) / 1.539771 = $703.34
    const wac = tracker.avgAt("SPYX", 1715000000);
    expect(wac).not.toBeNull();
    expect(wac!).toBeCloseTo((1000 + 2000 * 0.041496) / (1.402811 + 0.13696), 1);
    // Ключевое: wac > 0 — step 3 не SKIPPED (раньше был 712.85 — только step 1).
    // Cumulative bought = sum of both buys (1.54 SPYx).
  });

  it("wstETH ≠ stETH (не должен trogan wrap-strip — длинный lowercase prefix)", () => {
    const ops: ClassifiedOp[] = [
      op({
        type: "swap",
        hash: "0x1",
        time: 1700000000,
        movements: [
          mv({ dir: "out", symbol: "USDC", amount: 1000, usd: 1000, isStable: true }),
          mv({ dir: "in", symbol: "wstETH", amount: 0.5, usd: 1000 }),
        ],
      }),
    ];
    const tracker = buildCostBasisTracker(ops);
    // wstETH сохраняется как "WSTETH", не "STETH" (защита от ложного strip).
    expect(tracker.avgAt("wstETH", 1700100000)).toBeCloseTo(2000, 1);
    expect(tracker.avgAt("WSTETH", 1700100000)).toBeCloseTo(2000, 1);
    expect(tracker.avgAt("stETH", 1700100000)).toBeNull(); // stETH ≠ wstETH
  });
});
