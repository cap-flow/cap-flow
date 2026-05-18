/**
 * UCB invariant: token→token swap должен наследовать cost basis от
 * **consumed source lot's WAC**, не market price на момент свопа.
 *
 * Кейс: купил 1 BTC за $20k. Цена BTC выросла до $50k. Свапнул 1 BTC →
 * 25 ETH. По UCB:
 *   - 1 BTC consumed → WAC $20k flows out
 *   - 25 ETH acquired с total cost = $20k → cost per ETH = $800
 *
 * НЕ:
 *   - market BTC × 1 = $50k → cost per ETH = $2000 (это ИНФЛЯЦИЯ
 *     cost basis за счёт price appreciation, ломает realized PnL).
 *
 * Reference: cost basis = actual paid, never market value at any point.
 */
import { describe, expect, it } from "vitest";

import { buildLotTrackerFromOps } from "./build";
import type { ClassifiedOp } from "../types";

function op(args: {
  hash: string;
  type: string;
  time: number;
  chain?: string;
  movements: Array<{
    direction: "in" | "out";
    symbol: string;
    amount: number;
    usd?: number | null;
    tokenId?: string;
    isStable?: boolean;
  }>;
}): ClassifiedOp {
  return {
    hash: args.hash,
    type: args.type as never,
    time: args.time,
    chain: args.chain ?? "eth",
    status: "success",
    movement: args.movements.map((m) => ({
      direction: m.direction,
      symbol: m.symbol,
      amount: m.amount,
      usd: m.usd ?? null,
      tokenId: m.tokenId ?? m.symbol.toLowerCase(),
      isStable: m.isStable ?? ["USDC", "USDT", "DAI"].includes(m.symbol),
      isProtocolToken: false,
    })),
    protocol: null,
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

const WALLET = "w1";

describe("UCB invariant: token→token swap inherits source WAC, not market", () => {
  it("BTC→ETH at appreciated BTC price → ETH WAC = consumed BTC cost / received ETH", () => {
    const ops: ClassifiedOp[] = [
      // 1. Buy 1 BTC for 20,000 USDC (cost basis $20k, WAC $20k/BTC)
      op({
        hash: "0xbuyBtc",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDC", amount: 20000, usd: 20000, isStable: true },
          { direction: "in", symbol: "BTC", amount: 1.0, usd: 20000, tokenId: "btc" },
        ],
      }),
      // 2. Свопаем 1 BTC → 25 ETH когда BTC market = $50k, ETH market = $2k
      op({
        hash: "0xswapBtcEth",
        type: "swap",
        time: 2000,
        movements: [
          // m.usd reflects market: 1 BTC × $50k = $50,000
          { direction: "out", symbol: "BTC", amount: 1.0, usd: 50000, tokenId: "btc" },
          // m.usd reflects market: 25 ETH × $2k = $50,000
          { direction: "in", symbol: "ETH", amount: 25, usd: 50000, tokenId: "eth" },
        ],
      }),
    ];

    const tracker = buildLotTrackerFromOps(ops, {
      walletId: WALLET,
      histPrices: new Map(),
    });

    // After all ops, ETH WAC should reflect ACTUAL paid cost ($20k),
    // not market value at swap time ($50k).
    const ethWac = tracker.wacAt(WALLET, "ETH", 3000);
    expect(ethWac).not.toBeNull();
    // Expected: $20,000 / 25 ETH = $800/ETH
    expect(ethWac).toBeCloseTo(800, 0);
  });

  it("partial swap: 0.5 BTC → 12.5 ETH inherits half of source WAC", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xbuyBtc",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDC", amount: 20000, usd: 20000, isStable: true },
          { direction: "in", symbol: "BTC", amount: 1.0, usd: 20000, tokenId: "btc" },
        ],
      }),
      op({
        hash: "0xswapHalf",
        type: "swap",
        time: 2000,
        movements: [
          { direction: "out", symbol: "BTC", amount: 0.5, usd: 25000, tokenId: "btc" },
          { direction: "in", symbol: "ETH", amount: 12.5, usd: 25000, tokenId: "eth" },
        ],
      }),
    ];
    const tracker = buildLotTrackerFromOps(ops, {
      walletId: WALLET,
      histPrices: new Map(),
    });

    const ethWac = tracker.wacAt(WALLET, "ETH", 3000);
    // 0.5 BTC consumed at WAC $20k/BTC = $10k flows to 12.5 ETH
    // ETH WAC = $10,000 / 12.5 = $800
    expect(ethWac).toBeCloseTo(800, 0);

    // Remaining BTC: 0.5 @ $20k WAC = $10,000 cost
    const btcWac = tracker.wacAt(WALLET, "BTC", 3000);
    expect(btcWac).toBeCloseTo(20000, 0);
  });

  it("multi-source swap (BTC + ETH → SOL): paid USD = consumed cost from all sources", () => {
    const ops: ClassifiedOp[] = [
      // Buy 1 BTC for $20k, 10 ETH for $20k total
      op({
        hash: "0xbuyBtc",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDC", amount: 20000, usd: 20000, isStable: true },
          { direction: "in", symbol: "BTC", amount: 1.0, usd: 20000, tokenId: "btc" },
        ],
      }),
      op({
        hash: "0xbuyEth",
        type: "swap",
        time: 1500,
        movements: [
          { direction: "out", symbol: "USDC", amount: 20000, usd: 20000, isStable: true },
          { direction: "in", symbol: "ETH", amount: 10, usd: 20000, tokenId: "eth" },
        ],
      }),
      // Свопаем 1 BTC + 10 ETH (на market = $50k + $30k = $80k) → 200 SOL
      op({
        hash: "0xswapMulti",
        type: "swap",
        time: 2000,
        movements: [
          { direction: "out", symbol: "BTC", amount: 1.0, usd: 50000, tokenId: "btc" },
          { direction: "out", symbol: "ETH", amount: 10, usd: 30000, tokenId: "eth" },
          { direction: "in", symbol: "SOL", amount: 200, usd: 80000, tokenId: "sol" },
        ],
      }),
    ];
    const tracker = buildLotTrackerFromOps(ops, {
      walletId: WALLET,
      histPrices: new Map(),
    });

    const solWac = tracker.wacAt(WALLET, "SOL", 3000);
    // Consumed cost: $20k (BTC) + $20k (ETH) = $40k flows to 200 SOL
    // SOL WAC = $40,000 / 200 = $200
    expect(solWac).toBeCloseTo(200, 0);
  });

  it("token→token swap БЕЗ existing source lots → fallback к market", () => {
    // Edge case: swap из ETH когда tracker не имеет ETH lots
    // (например external transfer_in без cost basis установлен).
    // Fallback: use market m.usd как paidUsd.
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xswap",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "ETH", amount: 1, usd: 2000, tokenId: "eth" },
          { direction: "in", symbol: "USDC", amount: 2000, usd: 2000, tokenId: "usdc", isStable: true },
        ],
      }),
    ];
    const tracker = buildLotTrackerFromOps(ops, {
      walletId: WALLET,
      histPrices: new Map(),
    });
    // No assertion on cost basis for stable IN; just ensure no crash.
    // The point: when source lacks lots, fall back to market gracefully.
    expect(tracker).toBeDefined();
  });
});
