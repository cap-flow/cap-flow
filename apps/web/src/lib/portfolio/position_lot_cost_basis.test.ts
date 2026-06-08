/**
 * UCB C4: tests for `getPositionLotCostBasis` to ensure it:
 *   1. Respects `costBasisOverrideByHash` (A4 manual / D3 CEX / C2 fiat-hop /
 *      C3 cross-wallet inheritance) when registering acquisitions
 *   2. Handles `transfer_in` events с inherited cost basis
 *   3. Uses net supplied amount (supplied - withdrawn) for consume, не
 *      live amount (которое включает yield → over-counts cost)
 *   4. Sum of `consumedLots.costUsd` == `totalCostUsd` (line-sum == footer
 *      invariant — фикс UI bug в popup'е)
 *
 * Это refactor для приведения popup'а к LotTracker SoT консистентности.
 */
import { describe, expect, it } from "vitest";

import { getPositionLotCostBasis } from "./position_lot_cost_basis";
import type { ClassifiedOp } from "./types";

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
      isStable: m.isStable ?? ["USDC", "USDT", "DAI"].includes(m.symbol),
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

describe("getPositionLotCostBasis — UCB C4 popup SoT consistency", () => {
  const WALLET = "w1";
  const PROTO = "arb_fluid";

  it("invariant: Σ consumedLots.costUsd == totalCostUsd для каждой методики", () => {
    // Vladimir POS-002 scenario: 2 swaps + 1 deposit_fiat → 3.4 ETH supplied
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xswapA",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDC", amount: 3858, usd: 3858, isStable: true },
          { direction: "in", symbol: "ETH", amount: 1.2286, usd: 2598, tokenId: "arb" },
        ],
      }),
      op({
        hash: "0xswapB",
        type: "swap",
        time: 2000,
        movements: [
          { direction: "out", symbol: "USDT", amount: 7000, usd: 6996, isStable: true },
          { direction: "in", symbol: "ETH", amount: 2.2286, usd: 4712, tokenId: "arb" },
        ],
      }),
      op({
        hash: "0xsupplyA",
        type: "lend_supply",
        time: 3000,
        protocol: { id: PROTO, name: "Fluid", category: "lending" },
        movements: [{ direction: "out", symbol: "ETH", amount: 3.4572, usd: 7310, tokenId: "arb" }],
      }),
    ];

    for (const methodology of ["FIFO", "LIFO", "WAC"] as const) {
      const result = getPositionLotCostBasis({
        ops,
        walletId: WALLET,
        protocolId: PROTO,
        chain: "arb",
        symbol: "ETH",
        currentAmount: 3.4572,
        methodology,
      });
      const sumLots = result.consumedLots.reduce((s, l) => s + l.costUsd, 0);
      expect(sumLots).toBeCloseTo(result.totalCostUsd, 2);
      expect(result.totalCostUsd).toBeCloseTo(3858 + 7000, 0);
    }
  });

  it("respects costBasisOverrideByHash на deposit_fiat (C2 fiat-hop inheritance)", () => {
    // deposit_fiat 2.165 ETH market $4578 (m.usd), но C2 inherited
    // override = $9646 от cowswap на eth chain (трасса via Bitget).
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xdeposit",
        type: "deposit_fiat",
        time: 1000,
        movements: [
          // m.usd = $4578 (market price at deposit time)
          { direction: "in", symbol: "ETH", amount: 2.165, usd: 4578, tokenId: "arb" },
        ],
      }),
      op({
        hash: "0xsupply",
        type: "lend_supply",
        time: 2000,
        protocol: { id: PROTO, name: "Fluid", category: "lending" },
        movements: [
          { direction: "out", symbol: "ETH", amount: 2.154, usd: 4555, tokenId: "arb" },
        ],
      }),
    ];

    // C2 override: реальный cost = $9646 (paid for these ETH через cowswap)
    const overrides = new Map([["0xdeposit", 9646]]);

    const result = getPositionLotCostBasis({
      ops,
      walletId: WALLET,
      protocolId: PROTO,
      chain: "arb",
      symbol: "ETH",
      currentAmount: 2.154,
      methodology: "WAC",
      costBasisOverrideByHash: overrides,
    });

    // Без override был бы $4578 × (2.154 / 2.165) ≈ $4554.
    // С override: $9646 × (2.154 / 2.165) ≈ $9596.
    expect(result.totalCostUsd).toBeGreaterThan(9400);
    expect(result.totalCostUsd).toBeLessThan(9700);
    // line sum == footer (UI bug fix invariant)
    const sumLots = result.consumedLots.reduce((s, l) => s + l.costUsd, 0);
    expect(sumLots).toBeCloseTo(result.totalCostUsd, 2);
  });

  it("respects override на transfer_in (C3 cross-wallet inheritance)", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xtin",
        type: "transfer_in",
        time: 1000,
        movements: [
          // m.usd = $1318 market, но real cost from other wallet WAC = $3000
          { direction: "in", symbol: "ETH", amount: 0.62, usd: 1318, tokenId: "arb" },
        ],
      }),
      op({
        hash: "0xsupply",
        type: "lend_supply",
        time: 2000,
        protocol: { id: PROTO, name: "Fluid", category: "lending" },
        movements: [
          { direction: "out", symbol: "ETH", amount: 0.62, usd: 1318, tokenId: "arb" },
        ],
      }),
    ];

    const overrides = new Map([["0xtin", 3000]]);
    const result = getPositionLotCostBasis({
      ops,
      walletId: WALLET,
      protocolId: PROTO,
      chain: "arb",
      symbol: "ETH",
      currentAmount: 0.62,
      methodology: "FIFO",
      costBasisOverrideByHash: overrides,
    });

    expect(result.totalCostUsd).toBeCloseTo(3000, 0);
  });

  it("uses net supplied (supplied - withdrawn) when useNetSuppliedAmount=true", () => {
    // User supplied 2.0 ETH total, withdrew 0.5, position live = 1.6 (1.5 + 0.1 yield).
    // Без useNetSuppliedAmount: consume 1.6 → over-counts на 0.1 ETH worth (yield).
    // С useNetSuppliedAmount: consume 1.5 (net supplied = supplied - withdrawn).
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xswap",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDC", amount: 4000, usd: 4000, isStable: true },
          { direction: "in", symbol: "ETH", amount: 2.0, usd: 4000, tokenId: "arb" },
        ],
      }),
      op({
        hash: "0xsupply",
        type: "lend_supply",
        time: 2000,
        protocol: { id: PROTO, name: "Fluid", category: "lending" },
        movements: [
          { direction: "out", symbol: "ETH", amount: 2.0, usd: 4000, tokenId: "arb" },
        ],
      }),
      op({
        hash: "0xwithdraw",
        type: "lend_withdraw",
        time: 3000,
        protocol: { id: PROTO, name: "Fluid", category: "lending" },
        movements: [
          { direction: "in", symbol: "ETH", amount: 0.5, usd: 1000, tokenId: "arb" },
        ],
      }),
    ];

    const result = getPositionLotCostBasis({
      ops,
      walletId: WALLET,
      protocolId: PROTO,
      chain: "arb",
      symbol: "ETH",
      currentAmount: 1.6, // live с yield
      methodology: "FIFO",
      useNetSuppliedAmount: true,
    });

    // Net supplied = 2.0 - 0.5 = 1.5 ETH @ $2000/ETH = $3000
    expect(result.totalAmountSupplied).toBeCloseTo(1.5, 3);
    expect(result.totalCostUsd).toBeCloseTo(3000, 0);
  });

  it("CRITICAL: withdraw_fiat consumes lot, deposit_fiat with C2 override is NOT double-counted", () => {
    // Vladimir POS-002 Aug 12: cowswap → withdraw_fiat → deposit_fiat
    // (CEX-hop). Без consume на withdraw_fiat обе стороны acquire lot,
    // FIFO consume eats both → inflated cost basis.
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xcowswap",
        type: "swap",
        time: 1000,
        chain: "eth",
        movements: [
          { direction: "out", symbol: "USDC", amount: 9646, usd: 9646, isStable: true },
          { direction: "in", symbol: "ETH", amount: 2.149, usd: 9646, tokenId: "eth" },
        ],
      }),
      op({
        hash: "0xwithdraw",
        type: "withdraw_fiat",
        time: 2000,
        chain: "eth",
        movements: [
          { direction: "out", symbol: "ETH", amount: 2.163, usd: 4573, tokenId: "eth" },
        ],
      }),
      op({
        hash: "0xdeposit",
        type: "deposit_fiat",
        time: 3000,
        chain: "arb",
        movements: [
          // m.usd = market $4578, но C2 override = inherited $9646
          { direction: "in", symbol: "ETH", amount: 2.165, usd: 4578, tokenId: "arb" },
        ],
      }),
      op({
        hash: "0xsupply",
        type: "lend_supply",
        time: 4000,
        protocol: { id: PROTO, name: "Fluid", category: "lending" },
        movements: [
          { direction: "out", symbol: "ETH", amount: 2.154, usd: 4555, tokenId: "arb" },
        ],
      }),
    ];

    // C2 fiat-hop override: deposit_fiat inherits $9646 from withdraw lot
    const overrides = new Map([["0xdeposit", 9646]]);

    const r = getPositionLotCostBasis({
      ops,
      walletId: WALLET,
      protocolId: PROTO,
      chain: "arb",
      symbol: "ETH",
      currentAmount: 2.154,
      methodology: "FIFO",
      useNetSuppliedAmount: true,
      costBasisOverrideByHash: overrides,
    });

    // ОЖИДАНИЕ:
    //   - cowswap acquire 2.149 ETH @ $4488/ETH
    //   - withdraw_fiat consume 2.163 ETH (FIFO от cowswap) — fully eats it
    //   - deposit_fiat acquire 2.165 ETH @ inherited $9646/2.165 = $4456/ETH
    //   - supply consume 2.154 ETH from remaining (deposit_fiat lot)
    //   - cost = 2.154 × $4456 ≈ $9598 (~$9646 × (2.154/2.165))
    //
    // НЕ должно быть double-count'а cowswap+deposit_fiat ≈ $19k.
    expect(r.totalCostUsd).toBeGreaterThan(9400);
    expect(r.totalCostUsd).toBeLessThan(9800);
    expect(r.totalCostUsd).toBeLessThan(15000); // strict: not double-counted
  });

  it("legacy mode (useNetSuppliedAmount=false): consume = currentAmount как раньше", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xswap",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDC", amount: 4000, usd: 4000, isStable: true },
          { direction: "in", symbol: "ETH", amount: 2.0, usd: 4000, tokenId: "arb" },
        ],
      }),
      op({
        hash: "0xsupply",
        type: "lend_supply",
        time: 2000,
        protocol: { id: PROTO, name: "Fluid", category: "lending" },
        movements: [
          { direction: "out", symbol: "ETH", amount: 1.5, usd: 3000, tokenId: "arb" },
        ],
      }),
    ];
    const result = getPositionLotCostBasis({
      ops,
      walletId: WALLET,
      protocolId: PROTO,
      chain: "arb",
      symbol: "ETH",
      currentAmount: 1.5,
      methodology: "FIFO",
    });
    // Default behavior (legacy): consume 1.5 ETH from pool.
    expect(result.totalAmountSupplied).toBeCloseTo(1.5, 3);
    expect(result.totalCostUsd).toBeCloseTo(3000, 0);
  });
});

describe("REGRESSION (aida POS-001): token→token swap наследует реальный cost", () => {
  // On-chain: aida отдала 718.82 USDC за 0.304514 WETH (ETH тогда ~$2360),
  // затем WETH→ETH→Fluid. Движок показывал $513.50 = 0.304514 × текущий спот
  // $1686 → скрыт −28% убыток. Корень: token→token ветка консумила source-лот
  // ПЕРЕД чтением его WAC → wacAt=null → fallback на market spot.
  const ops: ClassifiedOp[] = [
    op({
      hash: "0xin",
      type: "transfer_in",
      time: 1000,
      movements: [
        { direction: "in", symbol: "USDC", amount: 718.824102, usd: 719.11, isStable: true },
      ],
    }),
    // stable→token (эта ветка OK): WETH lot = уплаченный USDC $719.11.
    op({
      hash: "0xswap1",
      type: "swap",
      time: 2000,
      movements: [
        { direction: "out", symbol: "USDC", amount: 718.824102, usd: 719.11, isStable: true },
        { direction: "in", symbol: "WETH", amount: 0.304514, usd: 513.5 },
      ],
    }),
    // token→token: ETH ДОЛЖЕН унаследовать $719.11 от WETH-лота, НЕ market $513.
    op({
      hash: "0xswap2",
      type: "swap",
      time: 3000,
      movements: [
        { direction: "out", symbol: "WETH", amount: 0.304514, usd: 513.5 },
        { direction: "in", symbol: "ETH", amount: 0.304514, usd: 513.57 },
      ],
    }),
  ];

  it("ETH cost basis = реально уплаченный USDC ($719), не receive-side спот ($513)", () => {
    const result = getPositionLotCostBasis({
      ops,
      walletId: "w1",
      protocolId: "arb_fluid",
      chain: "arb",
      symbol: "ETH",
      currentAmount: 0.304514,
    });
    expect(result.totalCostUsd).toBeCloseTo(719.11, 0);
  });
});
