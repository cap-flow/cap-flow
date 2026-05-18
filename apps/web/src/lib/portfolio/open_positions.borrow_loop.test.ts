/**
 * UCB C9: borrow-funded positions должны иметь startUsd = $0 для
 * borrowed portion (НЕ market m.usd fallback).
 *
 * Real case (vladimir@cap-flow.ru POS-005 Fluid WBTC):
 *   - Buy 0.226 WBTC for $20k real USDC (3 swaps Nov-Dec)
 *   - Aave V3 supply → withdraw cycle (inherits cost basis)
 *   - Morpho Blue supply (consumes pool, no receipt — receipt-less)
 *   - Morpho Blue BORROW 0.226 WBTC (acquires lot @ $0)
 *   - Fluid supply 0.226 WBTC (consumes borrow lot)
 *   - + Mar 14: real swap $10k → 0.142 WBTC → Fluid supply
 *
 *   Expected Fluid POS-005 startUsd:
 *     - 0.226 borrowed @ $0 = $0
 *     - 0.142 real @ ~$70k/BTC = $10,000
 *     - TOTAL = $10,000
 *
 *   Bug (before C9): walker's `if (wac > 0)` condition falls back to
 *   m.usd when wac is exactly 0 (borrow-only pool). UI shows $27,648
 *   ($17,648 borrowed portion mis-priced at market + $10k real).
 *
 *   Fix: trust tracker when wac is set (even = 0). Use $0 for borrow
 *   loops. Fallback to m.usd ONLY when wacAt returns null (no data).
 */
import { describe, expect, it } from "vitest";

import { buildLotTrackerFromOps } from "./lots/build";
import { buildOpenPositions } from "./open_positions";
import type { ClassifiedOp } from "./types";
import type { LiveSnapshot } from "./live";

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

describe("UCB C9: borrow-funded positions cost basis", () => {
  it("LotTracker: borrowed WBTC → Fluid supply has wacAt = $0 (not fallback)", () => {
    const ops: ClassifiedOp[] = [
      // Buy 0.226 WBTC for $20k (3 swaps for simplicity → 1 swap)
      op({
        hash: "0xbuy",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDC", amount: 20000, usd: 20000, isStable: true },
          { direction: "in", symbol: "WBTC", amount: 0.226, usd: 17648 },
        ],
      }),
      // Morpho supply WBTC (consumes lot, no receipt — Morpho Blue receiptless)
      op({
        hash: "0xmorpho_supply",
        type: "lend_supply",
        time: 2000,
        protocol: { id: "arb_morphoblue", name: "Morpho", category: "lending" },
        movements: [
          { direction: "out", symbol: "WBTC", amount: 0.226, usd: 17648 },
        ],
      }),
      // Morpho borrow WBTC (acquires lot @ $0)
      op({
        hash: "0xmorpho_borrow",
        type: "borrow",
        time: 3000,
        protocol: { id: "arb_morphoblue", name: "Morpho", category: "lending" },
        movements: [
          { direction: "in", symbol: "WBTC", amount: 0.226, usd: 17648 },
        ],
      }),
    ];

    const tracker = buildLotTrackerFromOps(ops, {
      walletId: "w1",
      histPrices: new Map(),
    });

    // После всех ops, pool имеет 0.226 WBTC @ cost $0 (borrowed)
    const wac = tracker.wacAt("w1", "WBTC", 4000);
    expect(wac).toBe(0); // NOT null — explicit 0
  });

  it("buildOpenPositions: Fluid WBTC funded from borrow has startUsd = $0", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xbuy",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDC", amount: 20000, usd: 20000, isStable: true },
          { direction: "in", symbol: "WBTC", amount: 0.226, usd: 17648 },
        ],
      }),
      op({
        hash: "0xmorpho_supply",
        type: "lend_supply",
        time: 2000,
        protocol: { id: "arb_morphoblue", name: "Morpho", category: "lending" },
        movements: [{ direction: "out", symbol: "WBTC", amount: 0.226, usd: 17648 }],
      }),
      op({
        hash: "0xmorpho_borrow",
        type: "borrow",
        time: 3000,
        protocol: { id: "arb_morphoblue", name: "Morpho", category: "lending" },
        movements: [{ direction: "in", symbol: "WBTC", amount: 0.226, usd: 17648 }],
      }),
      op({
        hash: "0xfluid_supply",
        type: "lend_supply",
        time: 4000,
        protocol: { id: "arb_fluid", name: "Fluid", category: "lending" },
        movements: [{ direction: "out", symbol: "WBTC", amount: 0.226, usd: 17648 }],
      }),
    ];

    const live: LiveSnapshot = {
      totalUsd: 18000,
      tokens: [],
      sources: [],
      positions: [
        {
          protocolId: "arb_fluid",
          protocolName: "Fluid",
          chain: "arb",
          walletId: "w1",
          walletName: "test",
          category: "lending",
          itemName: "Lending",
          netUsd: 18000,
          assetUsd: 18000,
          debtUsd: 0,
          healthRate: null,
          supply: [{ symbol: "WBTC", amount: 0.226, usd: 18000, tokenId: "arb" }],
          borrow: [],
          rewards: [],
        },
      ],
    };

    const positions = buildOpenPositions([
      {
        wallet: { id: "w1", name: "test", address: "0xtest", chain: "evm", createdAt: new Date(0) } as never,
        ops, live,
      },
    ]);

    expect(positions).toHaveLength(1);
    const pos = positions[0]!;
    // UCB: Fluid WBTC funded from borrow → cost basis = $0
    expect(pos.startUsd).toBe(0);
  });

  it("mixed: borrow + real swap → startUsd = real_paid only", () => {
    // Vladimir's full POS-005 scenario:
    //   0.226 borrowed (Dec 6) — cost $0
    //   0.142 real swap (Mar 14) — cost $10k
    //   Total Fluid: $10,000
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xbuy1",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDC", amount: 20000, usd: 20000, isStable: true },
          { direction: "in", symbol: "WBTC", amount: 0.226, usd: 17648 },
        ],
      }),
      op({ hash: "0xmsup", type: "lend_supply", time: 2000,
        protocol: { id: "arb_morphoblue", name: "Morpho", category: "lending" },
        movements: [{ direction: "out", symbol: "WBTC", amount: 0.226, usd: 17648 }] }),
      op({ hash: "0xmbor", type: "borrow", time: 3000,
        protocol: { id: "arb_morphoblue", name: "Morpho", category: "lending" },
        movements: [{ direction: "in", symbol: "WBTC", amount: 0.226, usd: 17648 }] }),
      op({ hash: "0xfsup1", type: "lend_supply", time: 4000,
        protocol: { id: "arb_fluid", name: "Fluid", category: "lending" },
        movements: [{ direction: "out", symbol: "WBTC", amount: 0.226, usd: 17648 }] }),
      // Later: real swap + Fluid supply
      op({ hash: "0xbuy2", type: "swap", time: 5000,
        movements: [
          { direction: "out", symbol: "USDC", amount: 10000, usd: 10000, isStable: true },
          { direction: "in", symbol: "WBTC", amount: 0.142, usd: 11064 },
        ] }),
      op({ hash: "0xfsup2", type: "lend_supply", time: 6000,
        protocol: { id: "arb_fluid", name: "Fluid", category: "lending" },
        movements: [{ direction: "out", symbol: "WBTC", amount: 0.142, usd: 11064 }] }),
    ];

    const live: LiveSnapshot = {
      totalUsd: 28000,
      tokens: [],
      sources: [],
      positions: [
        {
          protocolId: "arb_fluid", protocolName: "Fluid", chain: "arb",
          walletId: "w1", walletName: "test", category: "lending", itemName: "Lending",
          netUsd: 28000, assetUsd: 28000, debtUsd: 0, healthRate: null,
          supply: [{ symbol: "WBTC", amount: 0.368, usd: 28000, tokenId: "arb" }],
          borrow: [], rewards: [],
        },
      ],
    };

    const positions = buildOpenPositions([
      {
        wallet: { id: "w1", name: "test", address: "0xtest", chain: "evm", createdAt: new Date(0) } as never,
        ops, live,
      },
    ]);

    const pos = positions[0]!;
    // Expected: $0 (borrowed 0.226) + $10,000 (real 0.142) = $10,000
    expect(pos.startUsd).toBeGreaterThan(9500);
    expect(pos.startUsd).toBeLessThan(10500);
  });
});
