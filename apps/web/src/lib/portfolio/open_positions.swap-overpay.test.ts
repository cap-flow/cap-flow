/**
 * Bug: POS-002 Fluid Lending в кошельке via.irk@gmail.com показывал
 * startUsd = $7250 (= sum m.usd at supply time, market price ETH=$2114),
 * но user реально заплатил $10,768 за supplied 3.4286 ETH (купил ETH
 * через swap по $3141/ETH из-за DEX slippage / MEV / DefiLlama price gap).
 *
 * Root cause: `buildSupplyToken` приоритезировала `cycleDeposit.usd`
 * (market price at deposit time) над `avgAtOpen × s.amount` (real WAC
 * cost basis from lot tracker). Comments в коде утверждали что
 * cycleDeposit "more precise" но это HOLD только когда swap price ≈
 * market price. При overpay (swap по worse rate) cycleDeposit
 * underestimates cost.
 *
 * UCB invariant: cost basis = actual amount user paid, не market value
 * at any point. Lot tracker WAC IS the truth. cycleDeposit ≈ market и
 * должна использоваться ТОЛЬКО как fallback когда tracker пуст.
 *
 * Fix: prefer `s.amount × avgAtOpen` когда tracker возвращает valid
 * avgAtOpen. cycleDeposit остаётся fallback path.
 */
import { describe, expect, it } from "vitest";

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
      isProtocolToken: false,
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

describe("Vladimir POS-002 Fluid — startUsd via LotTracker single-source-of-truth", () => {
  // Сценарий из реальных данных:
  //   t=1000: swap A — 3858 USDC → 1.2286 ETH (m.usd ETH=$2598 / market)
  //                                            user paid $3858 в USDC
  //                                            avg WAC = 3858/1.2286 = $3141
  //   t=2000: swap B — 7000 USDT → 2.2286 ETH (m.usd ETH=$4713 / market)
  //                                            user paid $7000 в USDT
  //                                            avg WAC = (3858+7000)/(1.2286+2.2286) = $3141
  //   t=3000: lend_supply 1.2 ETH в Fluid (m.usd=$2537.6 = market at supply)
  //   t=4000: lend_supply 2.2286 ETH в Fluid (m.usd=$4712.78 = market at supply)
  //
  // Total supplied: 3.4286 ETH
  // cycleDeposit.usd = $7250 (sum of m.usd at supply times — market price)
  // avgAtOpen × s.amount = 3.4286 × $3141 = $10,773 (actual cost basis)
  //
  // Expected startUsd: $10,773 (UCB cost basis = user paid).
  // BUG (before fix): $7250 (market value at supply).
  const ops: ClassifiedOp[] = [
    op({
      hash: "0xswapA",
      type: "swap",
      time: 1000,
      movements: [
        {
          direction: "out",
          symbol: "USDC",
          amount: 3858,
          usd: 3858,
          isStable: true,
        },
        {
          direction: "in",
          symbol: "ETH",
          amount: 1.2286,
          usd: 2598, // market price ETH=$2114 на момент swap
          tokenId: "arb",
        },
      ],
    }),
    op({
      hash: "0xswapB",
      type: "swap",
      time: 2000,
      movements: [
        {
          direction: "out",
          symbol: "USDT",
          amount: 7000,
          usd: 6996,
          isStable: true,
        },
        {
          direction: "in",
          symbol: "ETH",
          amount: 2.2286,
          usd: 4712, // market price ETH=$2114, но user реально заплатил $7000
          tokenId: "arb",
        },
      ],
    }),
    op({
      hash: "0xsupplyA",
      type: "lend_supply",
      time: 3000,
      protocol: { id: "arb_fluid", name: "Fluid", category: "lending" },
      movements: [
        {
          direction: "out",
          symbol: "ETH",
          amount: 1.2,
          usd: 2537.6, // market value at supply time (DeBank price)
          tokenId: "arb",
        },
      ],
    }),
    op({
      hash: "0xsupplyB",
      type: "lend_supply",
      time: 4000,
      protocol: { id: "arb_fluid", name: "Fluid", category: "lending" },
      movements: [
        {
          direction: "out",
          symbol: "ETH",
          amount: 2.2286,
          usd: 4712.78, // market value at supply time
          tokenId: "arb",
        },
      ],
    }),
  ];

  // Live snapshot: user has 3.4286 ETH в Fluid lending position сейчас.
  const live: LiveSnapshot = {
    totalUsd: 12000,
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
        netUsd: 12000,
        assetUsd: 12000,
        debtUsd: 0,
        healthRate: null,
        supply: [
          {
            symbol: "ETH",
            amount: 3.4286,
            usd: 12000,
            tokenId: "arb",
          },
        ],
        borrow: [],
        rewards: [],
      },
    ],
  };

  it("uses lot tracker WAC × amount для startUsd (UCB cost basis truth)", () => {
    const positions = buildOpenPositions([
      {
        wallet: {
          id: "w1",
          name: "test",
          address: "0xtest",
          chain: "evm",
          createdAt: new Date(0),
        } as never,
        ops,
        live,
      },
    ]);

    expect(positions).toHaveLength(1);
    const pos = positions[0]!;
    expect(pos.protocol.id).toBe("arb_fluid");
    const eth = pos.supplyTokens.find((t) => t.symbol === "ETH");
    expect(eth).toBeDefined();

    // avgBuyPrice should match WAC from prior swaps = $3141/ETH (averaged
    // 3858/1.2286 и 7000/2.2286, both ≈ $3141).
    expect(eth!.avgBuyPrice).toBeGreaterThan(3100);
    expect(eth!.avgBuyPrice).toBeLessThan(3200);

    // CRITICAL UCB invariant: startUsd = Σ (supply_amount × WAC_at_supply).
    // For this scenario:
    //   - Supply 1 (1.2 ETH) at t=3000 with WAC=$3141 → $3769
    //   - Supply 2 (2.2286 ETH) at t=4000 with WAC=$3141 → $7000
    // Total = $10,769 (cost basis of consumed ETH lots).
    //
    // Bug (before fix): ~$7250 (sum of m.usd from supply events =
    // market value at supply, not actual cost paid by user).
    expect(eth!.startUsd).toBeGreaterThan(10500);
    expect(eth!.startUsd).toBeLessThan(11000);
  });

  // Сценарий когда часть ETH пришла через transfer_in с D3 override
  // (CEX inheritance trail). Должно учесть override cost при подсчёте.
  it("учитывает D3 cost basis overrides для transfer_in lots", () => {
    const ops2: ClassifiedOp[] = [
      // 1. transfer_in 1.0 ETH (came from CEX, m.usd $2000 market value)
      op({
        hash: "0xtransferin",
        type: "transfer_in",
        time: 1000,
        movements: [
          {
            direction: "in",
            symbol: "ETH",
            amount: 1.0,
            usd: 2000, // market value (low)
            tokenId: "arb",
          },
        ],
      }),
      // 2. swap 5000 USDC → 1.0 ETH (user paid $5000)
      op({
        hash: "0xswap",
        type: "swap",
        time: 2000,
        movements: [
          {
            direction: "out",
            symbol: "USDC",
            amount: 5000,
            usd: 5000,
            isStable: true,
          },
          {
            direction: "in",
            symbol: "ETH",
            amount: 1.0,
            usd: 3500, // market (less than paid — slippage)
            tokenId: "arb",
          },
        ],
      }),
      // 3. lend_supply 2.0 ETH в Fluid
      op({
        hash: "0xsupply",
        type: "lend_supply",
        time: 3000,
        protocol: { id: "arb_fluid", name: "Fluid", category: "lending" },
        movements: [
          {
            direction: "out",
            symbol: "ETH",
            amount: 2.0,
            usd: 7000,
            tokenId: "arb",
          },
        ],
      }),
    ];

    const liveSnap: LiveSnapshot = {
      totalUsd: 7000,
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
          netUsd: 7000,
          assetUsd: 7000,
          debtUsd: 0,
          healthRate: null,
          supply: [
            {
              symbol: "ETH",
              amount: 2.0,
              usd: 7000,
              tokenId: "arb",
            },
          ],
          borrow: [],
          rewards: [],
        },
      ],
    };

    // D3 override: transfer_in лот реально стоил $4500 (CEX trail)
    // вместо m.usd $2000.
    const overrides = new Map([["0xtransferin", 4500]]);

    const positions = buildOpenPositions(
      [
        {
          wallet: {
            id: "w1",
            name: "test",
            address: "0xtest",
            chain: "evm",
            createdAt: new Date(0),
          } as never,
          ops: ops2,
          live: liveSnap,
        },
      ],
      { costBasisOverrideByHash: overrides },
    );

    expect(positions).toHaveLength(1);
    const eth = positions[0]!.supplyTokens.find((t) => t.symbol === "ETH");
    // Без override startUsd был бы based на market price ($2000+$5000=$7000).
    // С override: транзфер_in lot $4500 + swap lot $5000 = $9500 total
    // cost for 2 ETH supplied. WAC = $4750/ETH (averaged).
    expect(eth!.startUsd).toBeGreaterThan(9000);
    expect(eth!.startUsd).toBeLessThan(10000);
  });
});
