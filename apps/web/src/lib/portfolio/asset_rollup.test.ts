/**
 * UCB E1: tests for buildAssetRollup — cross-wallet aggregation by family.
 */
import { describe, expect, it } from "vitest";

import { buildAssetRollup, type LoadedInput } from "./asset_rollup";
import { LotTracker } from "./lots/lot_tracker";
import type { LiveSnapshot } from "./live";

function token(args: {
  symbol: string;
  amount: number;
  usd: number;
  chain?: string;
  walletId: string;
  walletName: string;
}): LiveSnapshot {
  return {
    totalUsd: args.usd,
    tokens: [
      {
        symbol: args.symbol,
        tokenId: args.symbol.toLowerCase(),
        chain: args.chain ?? "eth",
        amount: args.amount,
        price: args.amount > 0 ? args.usd / args.amount : null,
        usd: args.usd,
        walletId: args.walletId,
        walletName: args.walletName,
        isStable: ["USDT", "USDC", "DAI"].includes(args.symbol.toUpperCase()),
        isKnown: true,
      },
    ],
    positions: [],
  };
}

function trackerWith(args: {
  walletId: string;
  symbol: string;
  amount: number;
  costPerUnitUsd: number;
}): LotTracker {
  const t = new LotTracker("WAC");
  t.acquire({
    symbol: args.symbol,
    tokenId: args.symbol.toLowerCase(),
    chain: "eth",
    amount: args.amount,
    costPerUnitUsd: args.costPerUnitUsd,
    acquiredAt: 1000,
    acquiredVia: "swap",
    sourceHash: "0xtest",
    walletId: args.walletId,
  });
  return t;
}

describe("buildAssetRollup — UCB E1", () => {
  it("пустой input → пустой output", () => {
    expect(buildAssetRollup([])).toEqual([]);
  });

  it("один wallet, один token → одна family", () => {
    const inputs: LoadedInput[] = [
      {
        walletId: "w1",
        walletName: "Wallet A",
        live: token({
          symbol: "ETH",
          amount: 1,
          usd: 3000,
          walletId: "w1",
          walletName: "Wallet A",
        }),
      },
    ];
    const r = buildAssetRollup(inputs);
    expect(r).toHaveLength(1);
    expect(r[0]?.family).toBe("ETH");
    expect(r[0]?.totalAmount).toBe(1);
    expect(r[0]?.totalUsd).toBe(3000);
    expect(r[0]?.totalCostBasisUsd).toBe(0); // нет lot tracker
  });

  it("аккумулирует ETH + WETH через tokenFamily", () => {
    const inputs: LoadedInput[] = [
      {
        walletId: "w1",
        walletName: "A",
        live: token({
          symbol: "ETH",
          amount: 1,
          usd: 3000,
          walletId: "w1",
          walletName: "A",
        }),
      },
      {
        walletId: "w2",
        walletName: "B",
        live: token({
          symbol: "WETH",
          amount: 2,
          usd: 6000,
          walletId: "w2",
          walletName: "B",
        }),
      },
    ];
    const r = buildAssetRollup(inputs);
    expect(r).toHaveLength(1);
    expect(r[0]?.family).toBe("ETH");
    expect(r[0]?.totalAmount).toBe(3);
    expect(r[0]?.totalUsd).toBe(9000);
    expect(r[0]?.sources).toHaveLength(2);
  });

  it("cost basis through LotTracker → unrealized PnL", () => {
    const inputs: LoadedInput[] = [
      {
        walletId: "w1",
        walletName: "A",
        live: token({
          symbol: "ETH",
          amount: 1,
          usd: 3000,
          walletId: "w1",
          walletName: "A",
        }),
      },
    ];
    const tracker = trackerWith({
      walletId: "w1",
      symbol: "ETH",
      amount: 1,
      costPerUnitUsd: 2000,
    });
    const r = buildAssetRollup(inputs, {
      lotsByWallet: new Map([["w1", tracker]]),
    });
    expect(r[0]?.totalCostBasisUsd).toBe(2000);
    expect(r[0]?.unrealizedPnlUsd).toBe(1000);
    expect(r[0]?.unrealizedPnlPct).toBe(50);
    expect(r[0]?.wac).toBe(2000);
  });

  it("сортирует rollups по totalUsd desc", () => {
    const inputs: LoadedInput[] = [
      {
        walletId: "w1",
        walletName: "A",
        live: token({
          symbol: "ETH",
          amount: 1,
          usd: 3000,
          walletId: "w1",
          walletName: "A",
        }),
      },
      {
        walletId: "w2",
        walletName: "B",
        live: token({
          symbol: "USDT",
          amount: 5000,
          usd: 5000,
          walletId: "w2",
          walletName: "B",
        }),
      },
    ];
    const r = buildAssetRollup(inputs);
    expect(r[0]?.family).toBe("USDT");
    expect(r[1]?.family).toBe("ETH");
  });

  it("отбрасывает receipt-tokens (aUSDC, GLV…)", () => {
    const inputs: LoadedInput[] = [
      {
        walletId: "w1",
        walletName: "A",
        live: {
          totalUsd: 5000,
          tokens: [
            {
              symbol: "aUSDC",
              tokenId: "ausdc",
              chain: "eth",
              amount: 1000,
              price: 1,
              usd: 1000,
              walletId: "w1",
              walletName: "A",
              isStable: false,
              isKnown: true,
            },
            {
              symbol: "ETH",
              tokenId: "eth",
              chain: "eth",
              amount: 1,
              price: 3000,
              usd: 3000,
              walletId: "w1",
              walletName: "A",
              isStable: false,
              isKnown: true,
            },
          ],
          positions: [],
        },
      },
    ];
    const r = buildAssetRollup(inputs);
    expect(r).toHaveLength(1);
    expect(r[0]?.family).toBe("ETH");
  });

  it("фильтрует dust below minSourceUsd", () => {
    const inputs: LoadedInput[] = [
      {
        walletId: "w1",
        walletName: "A",
        live: token({
          symbol: "ETH",
          amount: 0.0001,
          usd: 0.3,
          walletId: "w1",
          walletName: "A",
        }),
      },
    ];
    expect(buildAssetRollup(inputs)).toHaveLength(0);
    expect(buildAssetRollup(inputs, { minSourceUsd: 0 })).toHaveLength(1);
  });
});
