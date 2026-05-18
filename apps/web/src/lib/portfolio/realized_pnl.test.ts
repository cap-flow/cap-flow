/**
 * UCB E3: tests for computeRealizedPnlByFamily.
 */
import { describe, expect, it } from "vitest";

import {
  computeRealizedPnlByFamily,
  computeRewardIncomeByFamily,
} from "./realized_pnl";
import type { ClassifiedOp } from "./types";

function op(args: {
  hash: string;
  type: string;
  time: number;
  chain?: string;
  movements: Array<{
    direction: "in" | "out";
    symbol: string;
    amount: number;
    usd?: number;
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
      usd: m.usd ?? 0,
      tokenId: m.symbol.toLowerCase(),
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
  } as ClassifiedOp;
}

describe("computeRealizedPnlByFamily — UCB E3", () => {
  it("пустой input → пустой output", () => {
    expect(computeRealizedPnlByFamily([], "w1")).toEqual([]);
  });

  it("buy + sell at gain: записывает realized +USD", () => {
    const ops: ClassifiedOp[] = [
      // Buy 1 ETH for $2000 USDT
      op({
        hash: "0xbuy",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDT", amount: 2000, usd: 2000 },
          { direction: "in", symbol: "ETH", amount: 1, usd: 2000 },
        ],
      }),
      // Sell 1 ETH for $3000 USDT
      op({
        hash: "0xsell",
        type: "swap",
        time: 2000,
        movements: [
          { direction: "out", symbol: "ETH", amount: 1, usd: 3000 },
          { direction: "in", symbol: "USDT", amount: 3000, usd: 3000 },
        ],
      }),
    ];
    const r = computeRealizedPnlByFamily(ops, "w1");
    expect(r).toHaveLength(1);
    expect(r[0]?.family).toBe("ETH");
    expect(r[0]?.realizedUsd).toBeCloseTo(1000, 2);
    expect(r[0]?.eventCount).toBe(1);
  });

  it("partial sell: realized = пропорциональная часть", () => {
    const ops: ClassifiedOp[] = [
      // Buy 2 ETH for $4000
      op({
        hash: "0xbuy",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDT", amount: 4000, usd: 4000 },
          { direction: "in", symbol: "ETH", amount: 2, usd: 4000 },
        ],
      }),
      // Sell 1 ETH for $3000 (cost basis 1 ETH × $2000 = $2000)
      op({
        hash: "0xsell",
        type: "swap",
        time: 2000,
        movements: [
          { direction: "out", symbol: "ETH", amount: 1, usd: 3000 },
          { direction: "in", symbol: "USDT", amount: 3000, usd: 3000 },
        ],
      }),
    ];
    const r = computeRealizedPnlByFamily(ops, "w1");
    expect(r[0]?.realizedUsd).toBeCloseTo(1000, 2);
  });

  it("loss case: realized -USD", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xbuy",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDT", amount: 5000, usd: 5000 },
          { direction: "in", symbol: "ETH", amount: 1, usd: 5000 },
        ],
      }),
      // Sell at loss
      op({
        hash: "0xsell",
        type: "swap",
        time: 2000,
        movements: [
          { direction: "out", symbol: "ETH", amount: 1, usd: 3000 },
          { direction: "in", symbol: "USDT", amount: 3000, usd: 3000 },
        ],
      }),
    ];
    const r = computeRealizedPnlByFamily(ops, "w1");
    expect(r[0]?.realizedUsd).toBeCloseTo(-2000, 2);
  });

  it("transfer_in + transfer_out (CEX move) → NO realized", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xin",
        type: "transfer_in",
        time: 1000,
        movements: [{ direction: "in", symbol: "ETH", amount: 1, usd: 2000 }],
      }),
      op({
        hash: "0xout",
        type: "transfer_out",
        time: 2000,
        movements: [{ direction: "out", symbol: "ETH", amount: 1, usd: 3000 }],
      }),
    ];
    const r = computeRealizedPnlByFamily(ops, "w1");
    expect(r).toEqual([]);
  });

  it("withdraw_fiat → realized counted (продал крипту за фиат)", () => {
    const ops: ClassifiedOp[] = [
      // Buy 1 ETH for $2000
      op({
        hash: "0xbuy",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDT", amount: 2000, usd: 2000 },
          { direction: "in", symbol: "ETH", amount: 1, usd: 2000 },
        ],
      }),
      // Withdraw to fiat at $3000
      op({
        hash: "0xfiat",
        type: "withdraw_fiat",
        time: 2000,
        movements: [{ direction: "out", symbol: "ETH", amount: 1, usd: 3000 }],
      }),
    ];
    const r = computeRealizedPnlByFamily(ops, "w1");
    expect(r[0]?.realizedUsd).toBeCloseTo(1000, 2);
  });

  it("token-to-token (ETH→BTC) → НЕ realize (rebasis)", () => {
    const ops: ClassifiedOp[] = [
      // Buy 1 ETH
      op({
        hash: "0xbuy",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDT", amount: 2000, usd: 2000 },
          { direction: "in", symbol: "ETH", amount: 1, usd: 2000 },
        ],
      }),
      // Swap ETH → BTC (cost rebasis)
      op({
        hash: "0xrebasis",
        type: "swap",
        time: 2000,
        movements: [
          { direction: "out", symbol: "ETH", amount: 1, usd: 3000 },
          { direction: "in", symbol: "BTC", amount: 0.03, usd: 3000 },
        ],
      }),
    ];
    const r = computeRealizedPnlByFamily(ops, "w1");
    // ETH→BTC = no stable-in side → no realization
    expect(r).toEqual([]);
  });

  it("multiple sells aggregated в одну family entry", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xbuy",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDT", amount: 10000, usd: 10000 },
          { direction: "in", symbol: "ETH", amount: 5, usd: 10000 },
        ],
      }),
      op({
        hash: "0xsell1",
        type: "swap",
        time: 2000,
        movements: [
          { direction: "out", symbol: "ETH", amount: 1, usd: 3000 },
          { direction: "in", symbol: "USDT", amount: 3000, usd: 3000 },
        ],
      }),
      op({
        hash: "0xsell2",
        type: "swap",
        time: 3000,
        movements: [
          { direction: "out", symbol: "ETH", amount: 2, usd: 4000 },
          { direction: "in", symbol: "USDT", amount: 4000, usd: 4000 },
        ],
      }),
    ];
    const r = computeRealizedPnlByFamily(ops, "w1");
    expect(r[0]?.eventCount).toBe(2);
    // sell1: 3000 - 2000 = +1000
    // sell2: 4000 - 4000 = 0
    expect(r[0]?.realizedUsd).toBeCloseTo(1000, 2);
  });

  // ─── UCB D6: reward sales realize full proceeds ───────────────────────
  it("D6: claim_rewards + sell за стейбл = realized full proceeds (cost=0)", () => {
    const ops: ClassifiedOp[] = [
      // Claim 1 ETH reward, market FMV $2000
      op({
        hash: "0xclaim",
        type: "claim_rewards",
        time: 1000,
        movements: [{ direction: "in", symbol: "ETH", amount: 1, usd: 2000 }],
      }),
      // Sell that ETH for $3000 USDT
      op({
        hash: "0xsell",
        type: "swap",
        time: 2000,
        movements: [
          { direction: "out", symbol: "ETH", amount: 1, usd: 3000 },
          { direction: "in", symbol: "USDT", amount: 3000, usd: 3000 },
        ],
      }),
    ];
    const r = computeRealizedPnlByFamily(ops, "w1");
    expect(r).toHaveLength(1);
    expect(r[0]?.family).toBe("ETH");
    // Cost = 0 (reward), proceeds = 3000 → realized = 3000.
    expect(r[0]?.realizedUsd).toBeCloseTo(3000, 2);
  });

  it("D6: reward via withdraw_fiat = full proceeds realized", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xclaim",
        type: "claim_rewards",
        time: 1000,
        movements: [{ direction: "in", symbol: "ETH", amount: 0.5, usd: 1500 }],
      }),
      op({
        hash: "0xfiat",
        type: "withdraw_fiat",
        time: 2000,
        movements: [{ direction: "out", symbol: "ETH", amount: 0.5, usd: 1800 }],
      }),
    ];
    const r = computeRealizedPnlByFamily(ops, "w1");
    // cost=0, proceeds=1800 → realized = 1800
    expect(r[0]?.realizedUsd).toBeCloseTo(1800, 2);
  });

  it("D6: bought ETH mixed с reward ETH — WAC брюётся как pool, sell = pro-rata", () => {
    const ops: ClassifiedOp[] = [
      // Buy 1 ETH for $2000
      op({
        hash: "0xbuy",
        type: "swap",
        time: 1000,
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
        movements: [{ direction: "in", symbol: "ETH", amount: 1, usd: 2500 }],
      }),
      // Sell 2 ETH for $6000
      // WAC = (1*2000 + 1*0) / 2 = $1000 per ETH
      // proceeds = 6000, cost = 2*1000 = 2000 → realized = 4000
      op({
        hash: "0xsell",
        type: "swap",
        time: 2000,
        movements: [
          { direction: "out", symbol: "ETH", amount: 2, usd: 6000 },
          { direction: "in", symbol: "USDT", amount: 6000, usd: 6000 },
        ],
      }),
    ];
    const r = computeRealizedPnlByFamily(ops, "w1");
    expect(r[0]?.realizedUsd).toBeCloseTo(4000, 2);
  });
});

describe("computeRewardIncomeByFamily — UCB D6", () => {
  it("пустой input → пустой output", () => {
    expect(computeRewardIncomeByFamily([])).toEqual([]);
  });

  it("аггрегирует FMV at receipt по family", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xc1",
        type: "claim_rewards",
        time: 1000,
        movements: [{ direction: "in", symbol: "ETH", amount: 0.5, usd: 1000 }],
      }),
      op({
        hash: "0xc2",
        type: "claim_rewards",
        time: 2000,
        movements: [{ direction: "in", symbol: "ETH", amount: 0.5, usd: 1500 }],
      }),
      op({
        hash: "0xc3",
        type: "claim_rewards",
        time: 3000,
        movements: [{ direction: "in", symbol: "ARB", amount: 100, usd: 200 }],
      }),
    ];
    const r = computeRewardIncomeByFamily(ops);
    expect(r).toHaveLength(2);
    // Sorted by fmvUsd desc
    expect(r[0]?.family).toBe("ETH");
    expect(r[0]?.fmvUsd).toBeCloseTo(2500, 2);
    expect(r[0]?.eventCount).toBe(2);
    expect(r[1]?.family).toBe("ARB");
    expect(r[1]?.fmvUsd).toBeCloseTo(200, 2);
  });

  it("игнорирует failed ops и не-reward типы", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xtransfer",
        type: "transfer_in",
        time: 1000,
        movements: [{ direction: "in", symbol: "ETH", amount: 1, usd: 2000 }],
      }),
      {
        ...op({
          hash: "0xfailed",
          type: "claim_rewards",
          time: 2000,
          movements: [{ direction: "in", symbol: "ETH", amount: 1, usd: 2000 }],
        }),
        status: "failed",
      } as ClassifiedOp,
    ];
    expect(computeRewardIncomeByFamily(ops)).toEqual([]);
  });

  it("stable rewards считаются по amount, не usd", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xc1",
        type: "claim_rewards",
        time: 1000,
        movements: [
          { direction: "in", symbol: "USDC", amount: 50, usd: 0 }, // usd missing
        ],
      }),
    ];
    const r = computeRewardIncomeByFamily(ops);
    expect(r[0]?.family).toBe("USDC");
    expect(r[0]?.fmvUsd).toBeCloseTo(50, 2);
  });
});
