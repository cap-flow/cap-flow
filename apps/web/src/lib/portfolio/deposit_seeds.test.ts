/**
 * UCB C1 S5: tests for client-side deposit-seed extraction.
 *
 * Source of truth: lot tracker. Для каждого on-chain transfer_out с
 * destination CEX (известный по `cexDepositHashes` set) — считаем cost
 * basis = `wacAt(walletId, symbol, op.time) × amount` per movement.
 * Aggregate USD по всем out-movements этой tx → один seed.
 */
import { describe, expect, it } from "vitest";

import { computeDepositSeedsFromOps } from "./deposit_seeds";
import { buildLotTrackerFromOps } from "./lots/build";
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

describe("computeDepositSeedsFromOps — UCB C1 S5", () => {
  it("пустой input → пустой output", () => {
    const tracker = buildLotTrackerFromOps([], { walletId: "w1" });
    expect(
      computeDepositSeedsFromOps([], "w1", "eth", tracker, new Set()),
    ).toEqual([]);
  });

  it("transfer_out (1 ETH) после buy 1 ETH @ $2000 → seed cost $2000", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xbuy",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDT", amount: 2000, usd: 2000 },
          { direction: "in", symbol: "ETH", amount: 1, usd: 2000 },
        ],
      }),
      op({
        hash: "0xtocex",
        type: "transfer_out",
        time: 2000,
        movements: [{ direction: "out", symbol: "ETH", amount: 1, usd: 3000 }],
      }),
    ];
    const tracker = buildLotTrackerFromOps(ops, { walletId: "w1" });
    const seeds = computeDepositSeedsFromOps(
      ops,
      "w1",
      "eth",
      tracker,
      new Set(["0xtocex"]),
    );
    expect(seeds).toHaveLength(1);
    expect(seeds[0]?.txHash).toBe("0xtocex");
    expect(seeds[0]?.costBasisUsd).toBeCloseTo(2000, 2);
    expect(seeds[0]?.chain).toBe("eth");
  });

  it("transfer_out НЕ в cexDepositHashes set → НЕ seed", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xbuy",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDT", amount: 2000, usd: 2000 },
          { direction: "in", symbol: "ETH", amount: 1, usd: 2000 },
        ],
      }),
      op({
        hash: "0xother",
        type: "transfer_out",
        time: 2000,
        movements: [{ direction: "out", symbol: "ETH", amount: 0.5, usd: 1500 }],
      }),
    ];
    const tracker = buildLotTrackerFromOps(ops, { walletId: "w1" });
    const seeds = computeDepositSeedsFromOps(
      ops,
      "w1",
      "eth",
      tracker,
      new Set(["0xtocex"]), // 0xother НЕ здесь
    );
    expect(seeds).toEqual([]);
  });

  it("multi-token transfer_out → aggregates per-token costs в одну seed", () => {
    const ops: ClassifiedOp[] = [
      // Buy 1 ETH @ $2000
      op({
        hash: "0xbuy1",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDT", amount: 2000, usd: 2000 },
          { direction: "in", symbol: "ETH", amount: 1, usd: 2000 },
        ],
      }),
      // Buy 0.1 BTC @ $5000
      op({
        hash: "0xbuy2",
        type: "swap",
        time: 1500,
        movements: [
          { direction: "out", symbol: "USDT", amount: 5000, usd: 5000 },
          { direction: "in", symbol: "BTC", amount: 0.1, usd: 5000 },
        ],
      }),
      // Transfer out: 0.5 ETH + 0.05 BTC одним tx (необычно, но возможно)
      op({
        hash: "0xtocex",
        type: "transfer_out",
        time: 2000,
        movements: [
          { direction: "out", symbol: "ETH", amount: 0.5, usd: 1500 },
          { direction: "out", symbol: "BTC", amount: 0.05, usd: 2500 },
        ],
      }),
    ];
    const tracker = buildLotTrackerFromOps(ops, { walletId: "w1" });
    const seeds = computeDepositSeedsFromOps(
      ops,
      "w1",
      "eth",
      tracker,
      new Set(["0xtocex"]),
    );
    expect(seeds).toHaveLength(1);
    // 0.5 ETH @ $2000 WAC = $1000 + 0.05 BTC @ $50000 WAC = $2500. Sum = $3500.
    expect(seeds[0]?.costBasisUsd).toBeCloseTo(3500, 2);
  });

  it("transfer_out до того как куплено → cost = 0 (нет WAC)", () => {
    const ops: ClassifiedOp[] = [
      // Transfer out ETH без предшествующего buy.
      op({
        hash: "0xtocex",
        type: "transfer_out",
        time: 2000,
        movements: [{ direction: "out", symbol: "ETH", amount: 1, usd: 3000 }],
      }),
    ];
    const tracker = buildLotTrackerFromOps(ops, { walletId: "w1" });
    const seeds = computeDepositSeedsFromOps(
      ops,
      "w1",
      "eth",
      tracker,
      new Set(["0xtocex"]),
    );
    // Cost basis unknown — но seed всё равно создаётся с 0 (server'у
    // полезно знать что мы пытались посчитать, source = explicit zero).
    expect(seeds).toHaveLength(1);
    expect(seeds[0]?.costBasisUsd).toBe(0);
  });

  it("withdraw_fiat НЕ создаёт seed (это другая категория)", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xbuy",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDT", amount: 2000, usd: 2000 },
          { direction: "in", symbol: "ETH", amount: 1, usd: 2000 },
        ],
      }),
      // withdraw_fiat — продажа за фиат, не deposit на CEX
      op({
        hash: "0xfiat",
        type: "withdraw_fiat",
        time: 2000,
        movements: [{ direction: "out", symbol: "ETH", amount: 1, usd: 3000 }],
      }),
    ];
    const tracker = buildLotTrackerFromOps(ops, { walletId: "w1" });
    const seeds = computeDepositSeedsFromOps(
      ops,
      "w1",
      "eth",
      tracker,
      new Set(["0xfiat"]),
    );
    // Only transfer_out / bridge_out квалифицируются как seed.
    expect(seeds).toEqual([]);
  });

  it("hash normalize: cexDepositHashes lowercase должна matchиться", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xBUY",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDT", amount: 2000, usd: 2000 },
          { direction: "in", symbol: "ETH", amount: 1, usd: 2000 },
        ],
      }),
      op({
        hash: "0xTOCEX",
        type: "transfer_out",
        time: 2000,
        movements: [{ direction: "out", symbol: "ETH", amount: 1, usd: 3000 }],
      }),
    ];
    const tracker = buildLotTrackerFromOps(ops, { walletId: "w1" });
    const seeds = computeDepositSeedsFromOps(
      ops,
      "w1",
      "eth",
      tracker,
      new Set(["0xtocex"]), // lowercase
    );
    expect(seeds).toHaveLength(1);
    expect(seeds[0]?.txHash).toBe("0xtocex"); // normalized output
  });
});
