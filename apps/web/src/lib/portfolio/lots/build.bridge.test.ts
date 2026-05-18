/**
 * UCB D5: tests for bridge_in cost basis inheritance.
 *
 * Сценарий: user накапливает USDT на eth chain, потом bridges его на arb.
 * После D5 cost basis должен сохраниться, а не пересчитаться по market price.
 */
import { describe, expect, it } from "vitest";

import { buildLotTrackerFromOps } from "./build";
import type { ClassifiedOp } from "../types";

function op(args: Partial<ClassifiedOp> & {
  hash: string;
  type: string;
  time: number;
  chain: string;
  movements: Array<{
    direction: "in" | "out";
    symbol: string;
    amount: number;
    usd?: number;
    tokenId?: string;
  }>;
}): ClassifiedOp {
  return {
    hash: args.hash,
    type: args.type as never,
    time: args.time,
    chain: args.chain,
    status: "success",
    movement: args.movements.map((m) => ({
      direction: m.direction,
      symbol: m.symbol,
      amount: m.amount,
      usd: m.usd ?? 0,
      tokenId: m.tokenId ?? `${m.symbol.toLowerCase()}-${args.chain}`,
      isStable: ["USDT", "USDC", "DAI"].includes(m.symbol.toUpperCase()),
    })),
    fnName: "",
    cateId: "",
    counter: "",
    counterName: "",
    project: null,
    protocol: null,
    fees: { gasUsd: 0, otherUsd: 0 },
    notes: [],
    seq: 0,
    isInternal: false,
    counterAddresses: [],
    netUsd: 0,
    gasUsd: 0,
    ...args,
  } as ClassifiedOp;
}

describe("buildLotTrackerFromOps — UCB D5 bridge cost basis inheritance", () => {
  it("bridge_in после bridge_out того же wallet'а наследует WAC", () => {
    const ops: ClassifiedOp[] = [
      // 1. Buy 1 ETH for $2000 on eth chain
      op({
        hash: "0xbuy",
        type: "swap",
        time: 1000,
        chain: "eth",
        movements: [
          { direction: "out", symbol: "USDT", amount: 2000, usd: 2000 },
          { direction: "in", symbol: "ETH", amount: 1, usd: 2000 },
        ],
      }),
      // 2. Bridge 1 ETH eth → arb (out side, eth)
      op({
        hash: "0xbridgeout",
        type: "bridge_out",
        time: 2000,
        chain: "eth",
        movements: [
          { direction: "out", symbol: "ETH", amount: 1, usd: 3000 },
        ],
      }),
      // 3. Bridge in 0.98 ETH on arb (lost 0.02 ETH to fee)
      //    Market price at bridge_in time = $3000/ETH, но мы должны
      //    использовать original WAC = $2000.
      op({
        hash: "0xbridgein",
        type: "bridge_in",
        time: 2001,
        chain: "arb",
        movements: [
          { direction: "in", symbol: "ETH", amount: 0.98, usd: 2940 },
        ],
      }),
    ];

    const tracker = buildLotTrackerFromOps(ops, { walletId: "w1" });
    const wac = tracker.currentWac("w1", "ETH");
    // После consume 1 ETH (cost $2000) + acquire 0.98 ETH (inherited cost $1960):
    //   lots = [{ ETH, 0.98, costPerUnit = 2000 }]
    // currentWac = $2000/ETH — оригинальная WAC сохранилась.
    expect(wac).toBeCloseTo(2000, 2);
  });

  it("bridge_in без prior lots в wallet'е → fallback на market", () => {
    const ops: ClassifiedOp[] = [
      // Fresh wallet, первый bridge_in без prior history
      op({
        hash: "0xbridgein",
        type: "bridge_in",
        time: 1000,
        chain: "arb",
        movements: [
          { direction: "in", symbol: "ETH", amount: 1, usd: 3000 },
        ],
      }),
    ];
    const tracker = buildLotTrackerFromOps(ops, { walletId: "w1" });
    const wac = tracker.currentWac("w1", "ETH");
    // Нет prior lots → fallback на m.usd = 3000.
    expect(wac).toBeCloseTo(3000, 2);
  });

  it("bridge_in с explicit overrideUsd имеет precedence над inherited WAC", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xbuy",
        type: "swap",
        time: 1000,
        chain: "eth",
        movements: [
          { direction: "out", symbol: "USDT", amount: 2000, usd: 2000 },
          { direction: "in", symbol: "ETH", amount: 1, usd: 2000 },
        ],
      }),
      op({
        hash: "0xbridgeout",
        type: "bridge_out",
        time: 2000,
        chain: "eth",
        movements: [{ direction: "out", symbol: "ETH", amount: 1, usd: 3000 }],
      }),
      op({
        hash: "0xbridgein",
        type: "bridge_in",
        time: 2001,
        chain: "arb",
        movements: [{ direction: "in", symbol: "ETH", amount: 1, usd: 3000 }],
      }),
    ];
    const overrides = new Map<string, number>([["0xbridgein", 1500]]);
    const tracker = buildLotTrackerFromOps(ops, {
      walletId: "w1",
      costBasisOverrideByHash: overrides,
    });
    const wac = tracker.currentWac("w1", "ETH");
    // Override $1500 для 1 ETH → wac = $1500/ETH (не $2000 inherited,
    // не $3000 market).
    expect(wac).toBeCloseTo(1500, 2);
  });

  it("bridge_in stablecoin сохраняет WAC ≈ $1 через chains", () => {
    const ops: ClassifiedOp[] = [
      // CEX deposit 1000 USDT on eth
      op({
        hash: "0xdeposit",
        type: "transfer_in",
        time: 1000,
        chain: "eth",
        movements: [
          { direction: "in", symbol: "USDT", amount: 1000, usd: 1000 },
        ],
      }),
      // Bridge eth → arb
      op({
        hash: "0xbridgeout",
        type: "bridge_out",
        time: 2000,
        chain: "eth",
        movements: [
          { direction: "out", symbol: "USDT", amount: 1000, usd: 1000 },
        ],
      }),
      op({
        hash: "0xbridgein",
        type: "bridge_in",
        time: 2001,
        chain: "arb",
        movements: [
          { direction: "in", symbol: "USDT", amount: 995, usd: 995 },
        ],
      }),
    ];
    const tracker = buildLotTrackerFromOps(ops, { walletId: "w1" });
    const wac = tracker.currentWac("w1", "USDT");
    expect(wac).toBeCloseTo(1.0, 3);
  });
});
