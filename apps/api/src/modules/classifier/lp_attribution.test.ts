import { describe, expect, it } from "vitest";

import { computeLpCloseAttribution } from "./lp_attribution.js";
import type { ClassifiedOp, OpType, TokenMovement } from "./types.js";

function op(partial: {
  type: OpType;
  hash: string;
  time: number;
  protocolId?: string;
  chain?: string;
  status?: "ok" | "failed";
  notes?: string[];
  ins?: Array<{ symbol: string; amount: number; usd?: number | null }>;
  outs?: Array<{ symbol: string; amount: number; usd?: number | null }>;
}): ClassifiedOp {
  const movement: TokenMovement[] = [
    ...(partial.outs ?? []).map((o) => mv("out", o.symbol, o.amount, o.usd ?? null)),
    ...(partial.ins ?? []).map((i) => mv("in", i.symbol, i.amount, i.usd ?? null)),
  ];
  return {
    seq: 0,
    hash: partial.hash,
    chain: partial.chain ?? "arb",
    time: partial.time,
    status: partial.status ?? "ok",
    type: partial.type,
    protocol: partial.protocolId
      ? { id: partial.protocolId, name: partial.protocolId, category: "dex" }
      : null,
    movement,
    netUsd: 0,
    gasUsd: null,
    counterparty: null,
    feePayer: null,
    fnName: null,
    approveSpender: null,
    approveSymbol: null,
    ...(partial.notes ? { notes: partial.notes } : {}),
  };
}

function mv(
  direction: "in" | "out",
  symbol: string,
  amount: number,
  usd: number | null
): TokenMovement {
  return {
    direction,
    symbol,
    tokenId: `tk-${symbol}`,
    amount,
    usd,
    isStable: ["USDC", "USDT", "DAI"].includes(symbol),
    isProtocolToken: false,
  };
}

describe("computeLpCloseAttribution — basics", () => {
  it("empty input → empty map", () => {
    expect(computeLpCloseAttribution([]).size).toBe(0);
  });

  it("lp_remove without prior lp_add → ignored", () => {
    const r = computeLpCloseAttribution([
      op({
        type: "lp_remove",
        hash: "0xc",
        time: 200,
        protocolId: "uniswap3",
        ins: [{ symbol: "WETH", amount: 1, usd: 2000 }],
      }),
    ]);
    expect(r.size).toBe(0);
  });

  it("lp_add without lp_remove → empty (deposit recorded but nothing to attribute)", () => {
    const r = computeLpCloseAttribution([
      op({
        type: "lp_add",
        hash: "0xa",
        time: 100,
        protocolId: "uniswap3",
        outs: [{ symbol: "USDC", amount: 2000, usd: 2000 }],
      }),
    ]);
    expect(r.size).toBe(0);
  });
});

describe("computeLpCloseAttribution — single open + single close", () => {
  it("100% of deposit USD attributed to one close, distributed across in-symbols by USD share", () => {
    const r = computeLpCloseAttribution([
      op({
        type: "lp_add",
        hash: "0xa",
        time: 100,
        protocolId: "uniswap3",
        outs: [{ symbol: "USDC", amount: 1500, usd: 1500 }],
      }),
      op({
        type: "lp_remove",
        hash: "0xc",
        time: 200,
        protocolId: "uniswap3",
        ins: [
          { symbol: "WETH", amount: 0.5, usd: 1000 },
          { symbol: "USDC", amount: 500, usd: 500 },
        ],
      }),
    ]);
    const close = r.get("0xc");
    expect(close).toBeDefined();
    // WETH was 1000/1500 of close USD → 1000/1500 * 1500 (depositUsd) = 1000
    expect(close!.get("ETH")!.amount).toBeCloseTo(0.5, 6);
    expect(close!.get("ETH")!.costUsd).toBeCloseTo(1000, 6);
    expect(close!.get("USDC")!.amount).toBeCloseTo(500, 6);
    expect(close!.get("USDC")!.costUsd).toBeCloseTo(500, 6);
  });

  it("normalizes WETH → ETH in the result map", () => {
    const r = computeLpCloseAttribution([
      op({
        type: "lp_add",
        hash: "0xa",
        time: 100,
        protocolId: "uniswap3",
        outs: [{ symbol: "USDC", amount: 1000, usd: 1000 }],
      }),
      op({
        type: "lp_remove",
        hash: "0xc",
        time: 200,
        protocolId: "uniswap3",
        ins: [{ symbol: "WETH", amount: 1, usd: 1000 }],
      }),
    ]);
    const close = r.get("0xc")!;
    expect(close.has("ETH")).toBe(true);
    expect(close.has("WETH")).toBe(false);
  });
});

describe("computeLpCloseAttribution — multiple closes", () => {
  it("prorates depositUsd across multiple closes by their share of total close USD", () => {
    // Deposit $1000. Two closes: $300 + $700 = $1000 total returns.
    // Close #1 should get 300/1000 = 30% × 1000 deposit = $300 cost.
    // Close #2 should get 700/1000 = 70% × 1000 deposit = $700 cost.
    const r = computeLpCloseAttribution([
      op({
        type: "lp_add",
        hash: "0xa",
        time: 100,
        protocolId: "uniswap3",
        outs: [{ symbol: "USDC", amount: 1000, usd: 1000 }],
      }),
      op({
        type: "lp_remove",
        hash: "0xc1",
        time: 200,
        protocolId: "uniswap3",
        ins: [{ symbol: "USDC", amount: 300, usd: 300 }],
      }),
      op({
        type: "lp_remove",
        hash: "0xc2",
        time: 300,
        protocolId: "uniswap3",
        ins: [{ symbol: "USDC", amount: 700, usd: 700 }],
      }),
    ]);
    expect(r.get("0xc1")!.get("USDC")!.costUsd).toBeCloseTo(300, 6);
    expect(r.get("0xc2")!.get("USDC")!.costUsd).toBeCloseTo(700, 6);
  });
});

describe("computeLpCloseAttribution — multiple opens (single pool)", () => {
  it("sums deposits before attributing closes", () => {
    // Two deposits totaling $2000. Close returns 1 ETH ($2000).
    // Attribute full $2000 to ETH.
    const r = computeLpCloseAttribution([
      op({
        type: "lp_add",
        hash: "0xa1",
        time: 100,
        protocolId: "uniswap3",
        outs: [{ symbol: "USDC", amount: 1000, usd: 1000 }],
      }),
      op({
        type: "lp_add",
        hash: "0xa2",
        time: 150,
        protocolId: "uniswap3",
        outs: [{ symbol: "USDC", amount: 1000, usd: 1000 }],
      }),
      op({
        type: "lp_remove",
        hash: "0xc",
        time: 200,
        protocolId: "uniswap3",
        ins: [{ symbol: "ETH", amount: 1, usd: 2000 }],
      }),
    ]);
    expect(r.get("0xc")!.get("ETH")!.costUsd).toBeCloseTo(2000, 6);
  });
});

describe("computeLpCloseAttribution — separate protocols / chains", () => {
  it("Uniswap closes do not draw from Curve deposits", () => {
    const r = computeLpCloseAttribution([
      op({
        type: "lp_add",
        hash: "0xa1",
        time: 100,
        protocolId: "curve",
        outs: [{ symbol: "USDC", amount: 1000, usd: 1000 }],
      }),
      op({
        type: "lp_remove",
        hash: "0xc1",
        time: 200,
        protocolId: "uniswap3",
        ins: [{ symbol: "USDC", amount: 500, usd: 500 }],
      }),
    ]);
    // Uniswap had no deposit → close ignored.
    expect(r.get("0xc1")).toBeUndefined();
  });

  it("same protocol on different chains → separate groups", () => {
    const r = computeLpCloseAttribution([
      op({
        type: "lp_add",
        hash: "0xa-eth",
        time: 100,
        chain: "eth",
        protocolId: "uniswap3",
        outs: [{ symbol: "USDC", amount: 1000, usd: 1000 }],
      }),
      op({
        type: "lp_remove",
        hash: "0xc-arb",
        time: 200,
        chain: "arb",
        protocolId: "uniswap3",
        ins: [{ symbol: "USDC", amount: 500, usd: 500 }],
      }),
    ]);
    // arb-side close has no eth-side deposit to draw from → not attributed.
    expect(r.get("0xc-arb")).toBeUndefined();
  });
});

describe("computeLpCloseAttribution — failed / junk skipped", () => {
  it("ignores failed lp_add and lp_remove", () => {
    const r = computeLpCloseAttribution([
      op({
        type: "lp_add",
        hash: "0xa",
        time: 100,
        protocolId: "uniswap3",
        status: "failed",
        outs: [{ symbol: "USDC", amount: 1000, usd: 1000 }],
      }),
      op({
        type: "lp_remove",
        hash: "0xc",
        time: 200,
        protocolId: "uniswap3",
        ins: [{ symbol: "USDC", amount: 500, usd: 500 }],
      }),
    ]);
    // No valid deposit → close ignored.
    expect(r.size).toBe(0);
  });

  it("ignores junk-tagged ops", () => {
    const r = computeLpCloseAttribution([
      op({
        type: "lp_add",
        hash: "0xa",
        time: 100,
        protocolId: "uniswap3",
        outs: [{ symbol: "USDC", amount: 1000, usd: 1000 }],
        notes: ["junk:dust"],
      }),
      op({
        type: "lp_remove",
        hash: "0xc",
        time: 200,
        protocolId: "uniswap3",
        ins: [{ symbol: "USDC", amount: 500, usd: 500 }],
      }),
    ]);
    expect(r.size).toBe(0);
  });
});

describe("computeLpCloseAttribution — hist-price fallback for non-stable outs", () => {
  it("uses histPrices map for non-stable out (DefiLlama hourly bucket via symbol fallback)", () => {
    // out = 1 ETH at t=3600 with no spot price (m.usd=null). The symbol
    // "ETH" routes through defillamaCoinKey's symbol-fallback to
    // `coingecko:ethereum`. histPrices has $2000 in that bucket.
    // → depositUsd = 1 × 2000 = $2000. Close returns 1500 USDC ($1500),
    // attribution gets the full depositUsd (single close).
    const histPrices = new Map<string, number>();
    histPrices.set("coingecko:ethereum|3600", 2000);
    const r = computeLpCloseAttribution(
      [
        op({
          type: "lp_add",
          hash: "0xa",
          time: 3600 + 100,
          chain: "eth",
          protocolId: "uniswap3",
          outs: [{ symbol: "ETH", amount: 1, usd: null }],
        }),
        op({
          type: "lp_remove",
          hash: "0xc",
          time: 7200,
          chain: "eth",
          protocolId: "uniswap3",
          ins: [{ symbol: "USDC", amount: 1500, usd: 1500 }],
        }),
      ],
      histPrices
    );
    expect(r.get("0xc")!.get("USDC")!.costUsd).toBeCloseTo(2000, 6);
  });

  it("returns nothing when hist-price missing AND m.usd is null (non-stable)", () => {
    // ETH at t=3600 but histPrices empty AND m.usd=null → depositUsd=0 →
    // no attribution.
    const r = computeLpCloseAttribution(
      [
        op({
          type: "lp_add",
          hash: "0xa",
          time: 3600 + 100,
          chain: "eth",
          protocolId: "uniswap3",
          outs: [{ symbol: "ETH", amount: 1, usd: null }],
        }),
        op({
          type: "lp_remove",
          hash: "0xc",
          time: 7200,
          chain: "eth",
          protocolId: "uniswap3",
          ins: [{ symbol: "USDC", amount: 1500, usd: 1500 }],
        }),
      ],
      new Map()
    );
    expect(r.size).toBe(0);
  });

  it("stable symbol gets $1 regardless of missing usd field (m.usd=null)", () => {
    const r = computeLpCloseAttribution([
      op({
        type: "lp_add",
        hash: "0xa",
        time: 100,
        protocolId: "uniswap3",
        outs: [{ symbol: "USDC", amount: 1000, usd: null }],
      }),
      op({
        type: "lp_remove",
        hash: "0xc",
        time: 200,
        protocolId: "uniswap3",
        ins: [{ symbol: "USDC", amount: 1000, usd: 1000 }],
      }),
    ]);
    // Stables resolve to amount × $1, so depositUsd = 1000 → attribute full.
    expect(r.get("0xc")!.get("USDC")!.costUsd).toBeCloseTo(1000, 6);
  });
});

describe("computeLpCloseAttribution — input sort stability", () => {
  it("input does not need to be sorted by time", () => {
    const r = computeLpCloseAttribution([
      op({
        type: "lp_remove",
        hash: "0xc",
        time: 200,
        protocolId: "uniswap3",
        ins: [{ symbol: "USDC", amount: 500, usd: 500 }],
      }),
      op({
        type: "lp_add",
        hash: "0xa",
        time: 100,
        protocolId: "uniswap3",
        outs: [{ symbol: "USDC", amount: 500, usd: 500 }],
      }),
    ]);
    expect(r.get("0xc")!.get("USDC")!.costUsd).toBeCloseTo(500, 6);
  });
});
