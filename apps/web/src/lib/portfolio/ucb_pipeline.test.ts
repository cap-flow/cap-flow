/**
 * UCB C5: tests for runUcbPipelineForWallet — single source of truth.
 */
import { describe, expect, it } from "vitest";

import { runUcbPipeline, runUcbPipelineForWallet } from "./ucb_pipeline";
import type { ClassifiedOp } from "./types";
import type { ResolvedAnnotation } from "@/features/chain-ops/api";

function op(args: {
  hash: string;
  type: string;
  time: number;
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
    chain: "eth",
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

function ann(args: {
  hash: string;
  excluded?: boolean;
  manualOpType?: string;
}): ResolvedAnnotation {
  return {
    id: "id-" + args.hash,
    chainOpId: "cop-" + args.hash,
    userId: "u1",
    isInternalTransfer: null,
    manualCostBasisUsd: null,
    manualOpType: args.manualOpType ?? null,
    note: null,
    excluded: args.excluded ?? false,
    createdAt: new Date(1000).toISOString(),
    updatedAt: new Date(1000).toISOString(),
    txHash: args.hash,
    walletId: "w1",
    logIndex: 0,
  };
}

describe("runUcbPipelineForWallet — UCB C5 orchestrator", () => {
  it("empty ops → empty results", () => {
    const result = runUcbPipelineForWallet({
      walletId: "w1",
      ops: [],
      annotationsByKey: new Map(),
    });
    expect(result.effectiveOps).toEqual([]);
    expect(result.realizedPnl).toEqual([]);
    expect(result.rewardIncome).toEqual([]);
    expect(result.exclusionsCount).toBe(0);
  });

  it("buy + sell flow: lots tracker заполнен, realized PnL посчитан", () => {
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
        hash: "0xsell",
        type: "swap",
        time: 2000,
        movements: [
          { direction: "out", symbol: "ETH", amount: 1, usd: 3000 },
          { direction: "in", symbol: "USDT", amount: 3000, usd: 3000 },
        ],
      }),
    ];
    const result = runUcbPipelineForWallet({
      walletId: "w1",
      ops,
      annotationsByKey: new Map(),
    });
    expect(result.effectiveOps).toHaveLength(2);
    expect(result.realizedPnl).toHaveLength(1);
    expect(result.realizedPnl[0]?.family).toBe("ETH");
    expect(result.realizedPnl[0]?.realizedUsd).toBeCloseTo(1000, 2);
    expect(result.exclusionsCount).toBe(0);
  });

  it("D8: excluded op убран из всех stages (lots, realized, reward)", () => {
    const ops: ClassifiedOp[] = [
      // Bogus swap (excluded)
      op({
        hash: "0xbogus",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDT", amount: 100000, usd: 100000 },
          { direction: "in", symbol: "ETH", amount: 50, usd: 100000 },
        ],
      }),
      // Real buy
      op({
        hash: "0xreal",
        type: "swap",
        time: 1500,
        movements: [
          { direction: "out", symbol: "USDT", amount: 2000, usd: 2000 },
          { direction: "in", symbol: "ETH", amount: 1, usd: 2000 },
        ],
      }),
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
    const annMap = new Map([
      ["w1|0xbogus|0", ann({ hash: "0xbogus", excluded: true })],
    ]);
    const result = runUcbPipelineForWallet({
      walletId: "w1",
      ops,
      annotationsByKey: annMap,
    });
    expect(result.exclusionsCount).toBe(1);
    expect(result.effectiveOps).toHaveLength(2);
    // Realized PnL должен считаться от real buy ($2000), не от bogus
    expect(result.realizedPnl[0]?.realizedUsd).toBeCloseTo(1000, 2);
  });

  it("D6 reward + sale через orchestrator: full proceeds realized", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xclaim",
        type: "claim_rewards",
        time: 1000,
        movements: [{ direction: "in", symbol: "ARB", amount: 100, usd: 200 }],
      }),
      op({
        hash: "0xsell",
        type: "swap",
        time: 2000,
        movements: [
          { direction: "out", symbol: "ARB", amount: 100, usd: 250 },
          { direction: "in", symbol: "USDT", amount: 250, usd: 250 },
        ],
      }),
    ];
    const result = runUcbPipelineForWallet({
      walletId: "w1",
      ops,
      annotationsByKey: new Map(),
    });
    expect(result.rewardIncome).toHaveLength(1);
    expect(result.rewardIncome[0]?.family).toBe("ARB");
    expect(result.rewardIncome[0]?.fmvUsd).toBeCloseTo(200, 2);
    // cost=0 reward, proceeds=$250 → realized=250
    expect(result.realizedPnl[0]?.realizedUsd).toBeCloseTo(250, 2);
  });

  it("A4.1 manualOpType override применён через orchestrator", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xmisclassified",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "in", symbol: "USDT", amount: 100, usd: 100 },
        ],
      }),
    ];
    const annMap = new Map([
      [
        "w1|0xmisclassified|0",
        ann({ hash: "0xmisclassified", manualOpType: "transfer_in" }),
      ],
    ]);
    const result = runUcbPipelineForWallet({
      walletId: "w1",
      ops,
      annotationsByKey: annMap,
    });
    expect(result.effectiveOps[0]?.type).toBe("transfer_in");
  });

  it("costBasisOverrideByHash прокидывается в lots + realized PnL", () => {
    const ops: ClassifiedOp[] = [
      // CEX withdrawal → transfer_in on-chain, manual override = $500
      op({
        hash: "0xwithdraw",
        type: "transfer_in",
        time: 1000,
        movements: [{ direction: "in", symbol: "ETH", amount: 1, usd: 0 }],
      }),
      // Sell за $3000
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
    const overrides = new Map([["0xwithdraw", 500]]);
    const result = runUcbPipelineForWallet({
      walletId: "w1",
      ops,
      annotationsByKey: new Map(),
      costBasisOverrideByHash: overrides,
    });
    // cost=$500 (override), proceeds=$3000 → realized=$2500
    expect(result.realizedPnl[0]?.realizedUsd).toBeCloseTo(2500, 2);
  });

  // ─── C5.2: cross-wallet aggregation ─────────────────────────────────
  // ─── C5.4: full-path (lots + positions) и manual annotation merging ───
  it("C5.4: walletNameById передан → positionTracker заполнен", () => {
    const ops: ClassifiedOp[] = [
      // lend_supply event — должен попасть в position tracker
      op({
        hash: "0xsupply",
        type: "lend_supply",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDC", amount: 1000, usd: 1000 },
          { direction: "in", symbol: "aUSDC", amount: 1000, usd: 1000 },
        ],
      }),
    ];
    const result = runUcbPipelineForWallet({
      walletId: "w1",
      ops,
      annotationsByKey: new Map(),
      walletNameById: new Map([["w1", "Test Wallet"]]),
    });
    expect(result.positionTracker).toBeDefined();
    expect(result.lotTracker).toBeDefined();
  });

  it("C5.4: без walletNameById → positionTracker undefined (lots-only)", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xbuy",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDT", amount: 100, usd: 100 },
          { direction: "in", symbol: "ETH", amount: 0.05, usd: 100 },
        ],
      }),
    ];
    const result = runUcbPipelineForWallet({
      walletId: "w1",
      ops,
      annotationsByKey: new Map(),
    });
    expect(result.positionTracker).toBeUndefined();
    expect(result.lotTracker).toBeDefined();
  });

  it("C5.4: resolvedAnnotations с manualCostBasisUsd merged в overrides", () => {
    const ops: ClassifiedOp[] = [
      // transfer_in без USD price — будет cost=0 без override
      op({
        hash: "0xtransfer",
        type: "transfer_in",
        time: 1000,
        movements: [{ direction: "in", symbol: "ETH", amount: 1, usd: 0 }],
      }),
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
    // User manually annotated transfer_in with cost basis = $2000
    const annotation: ResolvedAnnotation = {
      id: "a1",
      chainOpId: "c1",
      userId: "u1",
      isInternalTransfer: null,
      manualCostBasisUsd: 2000,
      manualOpType: null,
      note: null,
      excluded: false,
      createdAt: new Date(1).toISOString(),
      updatedAt: new Date(1).toISOString(),
      txHash: "0xtransfer",
      walletId: "w1",
      logIndex: 0,
    };
    const result = runUcbPipelineForWallet({
      walletId: "w1",
      ops,
      annotationsByKey: new Map(),
      resolvedAnnotations: [annotation],
    });
    // cost=$2000 (manual), proceeds=$3000 → realized=$1000
    expect(result.realizedPnl[0]?.realizedUsd).toBeCloseTo(1000, 2);
  });

  it("C5.4: manual annotation precedence > server overrides", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xtransfer",
        type: "transfer_in",
        time: 1000,
        movements: [{ direction: "in", symbol: "ETH", amount: 1, usd: 0 }],
      }),
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
    const annotation: ResolvedAnnotation = {
      id: "a1",
      chainOpId: "c1",
      userId: "u1",
      isInternalTransfer: null,
      manualCostBasisUsd: 1500, // manual wins over $2500 server CEX
      manualOpType: null,
      note: null,
      excluded: false,
      createdAt: new Date(1).toISOString(),
      updatedAt: new Date(1).toISOString(),
      txHash: "0xtransfer",
      walletId: "w1",
      logIndex: 0,
    };
    const result = runUcbPipelineForWallet({
      walletId: "w1",
      ops,
      annotationsByKey: new Map(),
      costBasisOverrideByHash: new Map([["0xtransfer", 2500]]),
      resolvedAnnotations: [annotation],
    });
    // Manual $1500 wins → realized = 3000 - 1500 = $1500
    expect(result.realizedPnl[0]?.realizedUsd).toBeCloseTo(1500, 2);
  });

  it("runUcbPipeline — пустой input → пустой aggregated", () => {
    const result = runUcbPipeline([]);
    expect(result.perWallet.size).toBe(0);
    expect(result.realizedByFamily.size).toBe(0);
    expect(result.rewardIncomeByFamily.size).toBe(0);
    expect(result.totalExclusions).toBe(0);
  });

  it("runUcbPipeline — два wallet'а, realized PnL агрегирован по family", () => {
    const wallet1Ops: ClassifiedOp[] = [
      op({
        hash: "0xa1",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDT", amount: 2000, usd: 2000 },
          { direction: "in", symbol: "ETH", amount: 1, usd: 2000 },
        ],
      }),
      op({
        hash: "0xa2",
        type: "swap",
        time: 2000,
        movements: [
          { direction: "out", symbol: "ETH", amount: 1, usd: 3000 },
          { direction: "in", symbol: "USDT", amount: 3000, usd: 3000 },
        ],
      }),
    ];
    const wallet2Ops: ClassifiedOp[] = [
      op({
        hash: "0xb1",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDT", amount: 1000, usd: 1000 },
          { direction: "in", symbol: "ETH", amount: 0.5, usd: 1000 },
        ],
      }),
      op({
        hash: "0xb2",
        type: "swap",
        time: 2000,
        movements: [
          { direction: "out", symbol: "ETH", amount: 0.5, usd: 1200 },
          { direction: "in", symbol: "USDT", amount: 1200, usd: 1200 },
        ],
      }),
    ];
    const result = runUcbPipeline([
      { walletId: "w1", ops: wallet1Ops, annotationsByKey: new Map() },
      { walletId: "w2", ops: wallet2Ops, annotationsByKey: new Map() },
    ]);
    expect(result.perWallet.size).toBe(2);
    expect(result.realizedByFamily.get("ETH")).toBeDefined();
    // w1 realized: 1000, w2 realized: 200, total: 1200
    expect(result.realizedByFamily.get("ETH")?.realizedUsd).toBeCloseTo(1200, 2);
    expect(result.realizedByFamily.get("ETH")?.eventCount).toBe(2);
  });

  it("runUcbPipeline — reward income aggregated cross-wallet", () => {
    const inputs = [
      {
        walletId: "w1",
        ops: [
          op({
            hash: "0xc1",
            type: "claim_rewards",
            time: 1000,
            movements: [
              { direction: "in", symbol: "ARB", amount: 100, usd: 200 },
            ],
          }),
        ],
        annotationsByKey: new Map(),
      },
      {
        walletId: "w2",
        ops: [
          op({
            hash: "0xc2",
            type: "claim_rewards",
            time: 1000,
            movements: [
              { direction: "in", symbol: "ARB", amount: 50, usd: 100 },
            ],
          }),
        ],
        annotationsByKey: new Map(),
      },
    ];
    const result = runUcbPipeline(inputs);
    expect(result.rewardIncomeByFamily.get("ARB")?.fmvUsd).toBeCloseTo(300, 2);
    expect(result.rewardIncomeByFamily.get("ARB")?.eventCount).toBe(2);
  });

  it("runUcbPipeline — totalExclusions summed across wallets", () => {
    const inputs = [
      {
        walletId: "w1",
        ops: [
          op({ hash: "0xa", type: "swap", time: 1, movements: [] }),
          op({ hash: "0xb", type: "swap", time: 2, movements: [] }),
        ],
        annotationsByKey: new Map([
          ["w1|0xa|0", ann({ hash: "0xa", excluded: true })],
        ]),
      },
      {
        walletId: "w2",
        ops: [
          op({ hash: "0xc", type: "swap", time: 1, movements: [] }),
          op({ hash: "0xd", type: "swap", time: 2, movements: [] }),
        ],
        annotationsByKey: new Map([
          ["w2|0xc|0", ann({ hash: "0xc", excluded: true })],
          ["w2|0xd|0", ann({ hash: "0xd", excluded: true })],
        ]),
      },
    ];
    const result = runUcbPipeline(inputs);
    expect(result.totalExclusions).toBe(3);
  });

  it("exclusionsCount = diff между raw ops и effectiveOps", () => {
    const ops: ClassifiedOp[] = [
      op({ hash: "0xa", type: "swap", time: 1, movements: [] }),
      op({ hash: "0xb", type: "swap", time: 2, movements: [] }),
      op({ hash: "0xc", type: "swap", time: 3, movements: [] }),
    ];
    const annMap = new Map([
      ["w1|0xa|0", ann({ hash: "0xa", excluded: true })],
      ["w1|0xb|0", ann({ hash: "0xb", excluded: true })],
    ]);
    const result = runUcbPipelineForWallet({
      walletId: "w1",
      ops,
      annotationsByKey: annMap,
    });
    expect(result.exclusionsCount).toBe(2);
    expect(result.effectiveOps).toHaveLength(1);
  });
});
