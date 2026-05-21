/**
 * UCB C10: self-borrow inheritance — borrowed asset inherits cost basis
 * from same-asset collateral when supplied to same protocol.
 *
 * Use case: leverage loop pattern.
 *   1. User buys 0.226 WBTC for $20,000 USDC (3 swaps)
 *   2. User supplies 0.226 WBTC to Morpho Blue (collateral)
 *   3. User borrows 0.226 WBTC from same Morpho market
 *   4. User supplies borrowed WBTC to Fluid for yield
 *
 * Strict UCB (C9): borrow = $0 cost → Fluid 0.226 WBTC has $0 cost basis.
 * But: user paid $20k for those WBTC originally. The Morpho supply→borrow
 * cycle is plumbing — same asset goes around, real money paid was $20k.
 *
 * C10 fix: detect "self-loop" pattern — when borrow has SAME asset as
 * recently consumed supply in SAME protocol → inherit cost basis от
 * consumed collateral.
 *
 * Applies primarily to receipt-less protocols (Morpho Blue) where
 * collateral cost basis is "lost" through supply consume without
 * receipt-token acquisition. For Aave/Compound, aToken receipt preserves
 * cost basis, so self-borrow is rare.
 *
 * After C10: Fluid 0.226 WBTC inherits $20k cost basis → POS-005 Fluid =
 * $20k (from inherited) + $10k (Mar 14 real swap) = $30,000.
 * Morpho WBTC market: net zero (collateral consumed + debt taken — cancelled
 * by inheritance).
 */
import { describe, expect, it } from "vitest";

import { buildLotTrackerFromOps } from "./build";
import type { ClassifiedOp } from "../types";

function op(args: {
  hash: string;
  type: string;
  time: number;
  chain?: string;
  protocol?: { id: string; name: string; category: string } | null;
  movements: Array<{
    direction: "in" | "out";
    symbol: string;
    amount: number;
    usd?: number | null;
    tokenId?: string;
    isStable?: boolean;
    isProtocolToken?: boolean;
  }>;
}): ClassifiedOp {
  return {
    hash: args.hash,
    type: args.type as never,
    time: args.time,
    chain: args.chain ?? "arb",
    status: "success",
    movement: args.movements.map((m) => ({
      direction: m.direction,
      symbol: m.symbol,
      amount: m.amount,
      usd: m.usd ?? null,
      tokenId: m.tokenId ?? m.symbol.toLowerCase(),
      isStable: m.isStable ?? ["USDC", "USDT"].includes(m.symbol),
      isProtocolToken: m.isProtocolToken ?? false,
    })),
    protocol: args.protocol ?? null,
    netUsd: 0,
    gasUsd: null,
    counterparty: null,
    feePayer: null,
    fnName: null,
    approveSpender: null,
    approveSymbol: null,
    notes: [],
  } as ClassifiedOp;
}

describe("UCB C10: self-borrow inheritance (Morpho receipt-less leverage loop)", () => {
  const MORPHO = { id: "arb_morphoblue", name: "Morpho", category: "lending" as const };

  it("borrow same asset as supplied to same protocol → inherits cost basis", () => {
    const ops: ClassifiedOp[] = [
      // Buy 0.226 WBTC for $20,000 USDC
      op({
        hash: "0xbuy", type: "swap", time: 1000,
        movements: [
          { direction: "out", symbol: "USDC", amount: 20000, usd: 20000, isStable: true },
          { direction: "in", symbol: "WBTC", amount: 0.226, usd: 17648 },
        ],
      }),
      // Morpho Blue supply 0.226 WBTC (receipt-less, consumes lot)
      op({
        hash: "0xsupply", type: "lend_supply", time: 2000,
        protocol: MORPHO,
        movements: [{ direction: "out", symbol: "WBTC", amount: 0.226, usd: 17648 }],
      }),
      // Morpho borrow 0.226 WBTC (self-loop, should inherit $20k cost)
      op({
        hash: "0xborrow", type: "borrow", time: 3000,
        protocol: MORPHO,
        movements: [{ direction: "in", symbol: "WBTC", amount: 0.226, usd: 17648 }],
      }),
    ];

    const tracker = buildLotTrackerFromOps(ops, {
      walletId: "w1", histPrices: new Map(),
    });

    // After borrow, pool should have 0.226 WBTC at cost-per-unit ~$88,496
    // (inherited from collateral cost $20k/0.226).
    const wac = tracker.wacAt("w1", "WBTC", 4000);
    expect(wac).toBeCloseTo(20000 / 0.226, 0); // ~$88,496/WBTC
  });

  it("regular borrow (different asset) — cost basis stays $0", () => {
    // Borrow USDC against WBTC collateral — different asset, no inheritance.
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xbuy", type: "swap", time: 1000,
        movements: [
          { direction: "out", symbol: "ETH", amount: 1, usd: 4000, tokenId: "eth" },
          { direction: "in", symbol: "WBTC", amount: 0.05, usd: 4000 },
        ],
      }),
      op({
        hash: "0xsupply", type: "lend_supply", time: 2000,
        protocol: MORPHO,
        movements: [{ direction: "out", symbol: "WBTC", amount: 0.05, usd: 4000 }],
      }),
      op({
        hash: "0xborrow_usdc", type: "borrow", time: 3000,
        protocol: MORPHO,
        movements: [{ direction: "in", symbol: "USDC", amount: 1000, usd: 1000, isStable: true }],
      }),
    ];

    const tracker = buildLotTrackerFromOps(ops, {
      walletId: "w1", histPrices: new Map(),
    });

    // USDC borrowed as cross-asset → $0 cost (UCB strict — debt not own money).
    const usdcWac = tracker.wacAt("w1", "USDC", 4000);
    expect(usdcWac).toBe(0);
  });

  it("partial self-borrow → inherits proportional cost", () => {
    // Supply 0.5 WBTC ($50k), borrow 0.2 WBTC → inherits 0.2 × $100k/BTC = $20k
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xbuy", type: "swap", time: 1000,
        movements: [
          { direction: "out", symbol: "USDC", amount: 50000, usd: 50000, isStable: true },
          { direction: "in", symbol: "WBTC", amount: 0.5, usd: 50000 },
        ],
      }),
      op({
        hash: "0xsupply", type: "lend_supply", time: 2000,
        protocol: MORPHO,
        movements: [{ direction: "out", symbol: "WBTC", amount: 0.5, usd: 50000 }],
      }),
      op({
        hash: "0xborrow_partial", type: "borrow", time: 3000,
        protocol: MORPHO,
        movements: [{ direction: "in", symbol: "WBTC", amount: 0.2, usd: 20000 }],
      }),
    ];

    const tracker = buildLotTrackerFromOps(ops, {
      walletId: "w1", histPrices: new Map(),
    });

    // 0.2 borrowed inherits cost from 0.2 of collateral = $20k
    // Pool: 0.2 WBTC @ $100k/BTC = $20k
    const wac = tracker.wacAt("w1", "WBTC", 4000);
    expect(wac).toBeCloseTo(100000, -2); // $100k/BTC
  });

  it("borrow without prior supply → $0 cost (no self-loop to inherit)", () => {
    // Pure borrow (perhaps cross-collateralized via different asset, or fresh)
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xborrow_pure", type: "borrow", time: 1000,
        protocol: MORPHO,
        movements: [{ direction: "in", symbol: "WBTC", amount: 0.1, usd: 8000 }],
      }),
    ];

    const tracker = buildLotTrackerFromOps(ops, {
      walletId: "w1", histPrices: new Map(),
    });

    const wac = tracker.wacAt("w1", "WBTC", 2000);
    expect(wac).toBe(0); // pure borrow = $0 cost (strict UCB)
  });

  it("Vladimir POS-005 scenario: full loop + later real purchase", () => {
    const ops: ClassifiedOp[] = [
      // 1. Buy 0.226 WBTC for $20k
      op({ hash: "0xbuy1", type: "swap", time: 1000,
        movements: [
          { direction: "out", symbol: "USDC", amount: 20000, usd: 20000, isStable: true },
          { direction: "in", symbol: "WBTC", amount: 0.226, usd: 17648 },
        ] }),
      // 2. Morpho supply (consumes lot)
      op({ hash: "0xmsup", type: "lend_supply", time: 2000, protocol: MORPHO,
        movements: [{ direction: "out", symbol: "WBTC", amount: 0.226, usd: 17648 }] }),
      // 3. Morpho borrow (inherits $20k cost from supply)
      op({ hash: "0xmbor", type: "borrow", time: 3000, protocol: MORPHO,
        movements: [{ direction: "in", symbol: "WBTC", amount: 0.226, usd: 17648 }] }),
      // 4. Fluid supply (consumes inherited 0.226 @ ~$88k/BTC = $20k)
      op({ hash: "0xfsup1", type: "lend_supply", time: 4000,
        protocol: { id: "arb_fluid", name: "Fluid", category: "lending" },
        movements: [{ direction: "out", symbol: "WBTC", amount: 0.226, usd: 17648 }] }),
      // 5. Buy 0.142 WBTC for $10k real
      op({ hash: "0xbuy2", type: "swap", time: 5000,
        movements: [
          { direction: "out", symbol: "USDC", amount: 10000, usd: 10000, isStable: true },
          { direction: "in", symbol: "WBTC", amount: 0.142, usd: 11064 },
        ] }),
      // 6. Fluid supply (consumes new 0.142 @ ~$70k/BTC = $10k)
      op({ hash: "0xfsup2", type: "lend_supply", time: 6000,
        protocol: { id: "arb_fluid", name: "Fluid", category: "lending" },
        movements: [{ direction: "out", symbol: "WBTC", amount: 0.142, usd: 11064 }] }),
    ];

    const tracker = buildLotTrackerFromOps(ops, {
      walletId: "w1", histPrices: new Map(),
    });

    // After all ops, both Fluid supplies consumed their lots.
    const remaining = tracker.currentAmount("w1", "WBTC");
    expect(remaining).toBeLessThan(0.001); // ~0

    // UCB C11 regression: wacAt(time) должен реконструировать historical
    // amount-at-time даже для полностью consumed lots. Без C11 fix
    // эти проверки fail'или (wacAt возвращал null → walker fallback на
    // market price → cost basis раздут до $31,558 вместо $30,000 на /positions).
    //
    // 1st Fluid supply (time=4000): pool должен показать WAC = $20k/0.226
    // = $88,496/WBTC (cost basis самого первого лота, унаследованного через
    // self-borrow). Был null до C11.
    const wacAtFirstSupply = tracker.wacAt("w1", "WBTC", 4000);
    expect(wacAtFirstSupply).not.toBeNull();
    expect(wacAtFirstSupply!).toBeCloseTo(20000 / 0.226, 0);

    // 2nd Fluid supply (time=6000): pool должен показать WAC = $10k/0.142
    // = $70,422/WBTC (cost basis нового лота от 0xbuy2). Был null до C11.
    const wacAtSecondSupply = tracker.wacAt("w1", "WBTC", 6000);
    expect(wacAtSecondSupply).not.toBeNull();
    expect(wacAtSecondSupply!).toBeCloseTo(10000 / 0.142, 0);

    // Σ historical cost при supply moments = real spending $30k.
    // Это то значение которое walker (computePositionConsumedCostFromLots)
    // должен производить для POS-005 startUsd.
    const totalHistoricalCost =
      0.226 * wacAtFirstSupply! + 0.142 * wacAtSecondSupply!;
    expect(totalHistoricalCost).toBeCloseTo(30000, 0);
  });
});
