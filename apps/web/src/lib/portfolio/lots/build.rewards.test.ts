/**
 * UCB D6 (РЕВИЗИЯ owner 2026-06-10): claim_rewards lot acquisition.
 *
 * Было (D6 v1): reward lots с `costPerUnitUsd = 0` (награда «бесплатна»).
 * Стало (owner-решение на трейсе testakk Artur, клейм 4.98 ETH 31.01.2026):
 * **rewards входят в пул ПО РЫНОЧНОЙ ЦЕНЕ на момент клейма** — это
 * зафиксированный доход («получил актив стоимостью $X»); cost=0 занижал WAC
 * вдвое и завышал будущий PnL. `acquiredVia = "received_as_reward"` и
 * `fmvAtAcquisitionUsd` (для income reporting) сохраняются как раньше —
 * теперь fmv == cost basis лота.
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

describe("buildLotTrackerFromOps — UCB D6 reward lots (rewards @ market, owner 2026-06-10)", () => {
  it("claim_rewards создаёт лот с cost = FMV (рынок на момент клейма)", () => {
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
    // $200 за 100 ARB → $2/шт — зафиксированный доход
    expect(lot.costPerUnitUsd).toBeCloseTo(2, 6);
    expect(lot.acquiredVia).toBe("received_as_reward");
    expect(lot.fmvAtAcquisitionUsd).toBeCloseTo(200, 2);
  });

  it("WAC = market если только reward lots в pool", () => {
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
    expect(tracker.wacAt("w1", "ARB", 2000)).toBeCloseTo(2, 6);
  });

  it("buy + reward: WAC = (1×2000 + 1×3000) / 2 = 2500", () => {
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
      // Claim 1 ETH reward по рынку $3000
      op({
        hash: "0xclaim",
        type: "claim_rewards",
        time: 1500,
        chain: "eth",
        movements: [{ direction: "in", symbol: "ETH", amount: 1, usd: 3000 }],
      }),
    ];
    const tracker = buildLotTrackerFromOps(ops, { walletId: "w1" });
    expect(tracker.wacAt("w1", "ETH", 2000)).toBeCloseTo(2500, 2);
  });

  it("stable rewards: cost = номинал ($1=$1), fmv = amount", () => {
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
    expect(lots[0]?.costPerUnitUsd).toBeCloseTo(1, 6);
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
      // Claim 1 ETH reward @ $2500
      op({
        hash: "0xclaim",
        type: "claim_rewards",
        time: 1500,
        chain: "eth",
        movements: [{ direction: "in", symbol: "ETH", amount: 1, usd: 2500 }],
      }),
      // Sell 1 ETH for $3000 USDT
      // WAC = (2000+2500)/2 = 2250, consume 1 ETH → $2250 cost. Realized $750.
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
    // After selling 1 ETH @ WAC=2250: 1 ETH остался, WAC всё ещё 2250 (drift fix).
    const remaining = tracker.currentAmount("w1", "ETH");
    expect(remaining).toBeCloseTo(1, 6);
    expect(tracker.wacAt("w1", "ETH", 3000)).toBeCloseTo(2250, 2);
  });
});
