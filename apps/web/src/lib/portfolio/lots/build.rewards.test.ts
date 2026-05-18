/**
 * UCB D6: tests for claim_rewards lot acquisition.
 *
 * После D6 reward lots создаются с `costPerUnitUsd = 0` и
 * `acquiredVia = "received_as_reward"`. FMV at receipt сохраняется
 * на лоте в `fmvAtAcquisitionUsd` для income reporting.
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

describe("buildLotTrackerFromOps — UCB D6 reward lots", () => {
  it("claim_rewards создаёт лот с cost=0 и acquiredVia=received_as_reward", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xclaim",
        type: "claim_rewards",
        time: 1000,
        chain: "eth",
        movements: [{ direction: "in", symbol: "ARB", amount: 100, usd: 200 }],
      }),
    ];
    const tracker = buildLotTrackerFromOps(ops, { walletId: "w1" });
    const lots = tracker.getLots("w1", "ARB");
    expect(lots).toHaveLength(1);
    const lot = lots[0]!;
    expect(lot.costPerUnitUsd).toBe(0);
    expect(lot.acquiredVia).toBe("received_as_reward");
    expect(lot.fmvAtAcquisitionUsd).toBeCloseTo(200, 2);
  });

  it("WAC = 0 если только reward lots в pool (sale → full proceeds)", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xclaim",
        type: "claim_rewards",
        time: 1000,
        chain: "eth",
        movements: [{ direction: "in", symbol: "ARB", amount: 100, usd: 200 }],
      }),
    ];
    const tracker = buildLotTrackerFromOps(ops, { walletId: "w1" });
    expect(tracker.wacAt("w1", "ARB", 2000)).toBe(0);
  });

  it("buy + reward: WAC = (1*2000 + 1*0) / 2 = 1000", () => {
    const ops: ClassifiedOp[] = [
      // Buy 1 ETH for $2000
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
      // Claim 1 ETH reward (cost=0 в D6)
      op({
        hash: "0xclaim",
        type: "claim_rewards",
        time: 1500,
        chain: "eth",
        movements: [{ direction: "in", symbol: "ETH", amount: 1, usd: 3000 }],
      }),
    ];
    const tracker = buildLotTrackerFromOps(ops, { walletId: "w1" });
    expect(tracker.wacAt("w1", "ETH", 2000)).toBeCloseTo(1000, 2);
  });

  it("stable rewards: cost=0, fmv = amount (e.g. USDC airdrop)", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xclaim",
        type: "claim_rewards",
        time: 1000,
        chain: "eth",
        movements: [{ direction: "in", symbol: "USDC", amount: 50, usd: 0 }],
      }),
    ];
    const tracker = buildLotTrackerFromOps(ops, { walletId: "w1" });
    const lots = tracker.getLots("w1", "USDC");
    expect(lots[0]?.costPerUnitUsd).toBe(0);
    expect(lots[0]?.fmvAtAcquisitionUsd).toBeCloseTo(50, 2);
  });

  it("consume reward + bought lot: WAC pricing на консум, NOT FIFO per-lot", () => {
    const ops: ClassifiedOp[] = [
      // Buy 1 ETH @ $2000
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
      // Claim 1 ETH reward
      op({
        hash: "0xclaim",
        type: "claim_rewards",
        time: 1500,
        chain: "eth",
        movements: [{ direction: "in", symbol: "ETH", amount: 1, usd: 2500 }],
      }),
      // Sell 1 ETH for $3000 USDT
      // WAC = 1000, consume 1 ETH → $1000 cost. Proceeds 3000 → realized $2000.
      op({
        hash: "0xsell",
        type: "swap",
        time: 2000,
        chain: "eth",
        movements: [
          { direction: "out", symbol: "ETH", amount: 1, usd: 3000 },
          { direction: "in", symbol: "USDT", amount: 3000, usd: 3000 },
        ],
      }),
    ];
    const tracker = buildLotTrackerFromOps(ops, { walletId: "w1" });
    // After selling 1 ETH @ WAC=1000: 1 ETH остался, WAC всё ещё 1000 (drift fix).
    const remaining = tracker.currentAmount("w1", "ETH");
    expect(remaining).toBeCloseTo(1, 6);
    expect(tracker.wacAt("w1", "ETH", 3000)).toBeCloseTo(1000, 2);
  });
});
