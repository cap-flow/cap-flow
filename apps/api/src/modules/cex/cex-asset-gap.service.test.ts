/**
 * UCB Bob-test fix #5: tests for CexAssetGapService.
 *
 * Service aggregates trades + transfers per asset, calls pure detector.
 */
import { describe, expect, it } from "vitest";

import { CexAssetGapService } from "./cex-asset-gap.service.js";
import type {
  CexAccountRow,
  CexRepository,
  CexTradeRow,
  CexTransferRow,
} from "./cex.repository.js";

function makeRepo(args: {
  accounts: CexAccountRow[];
  trades?: Record<string, CexTradeRow[]>;
  transfers?: Record<string, CexTransferRow[]>;
}): CexRepository {
  return {
    async listActiveForUser() {
      return args.accounts;
    },
    async listTradesForAccount(id: string) {
      return args.trades?.[id] ?? [];
    },
    async listTransfersForAccountAsc(id: string) {
      return args.transfers?.[id] ?? [];
    },
  } as unknown as CexRepository;
}

const ACC: CexAccountRow = {
  id: "acc-1",
  userId: "u1",
  accountId: "a1",
  exchange: "bingx",
  label: null,
  apiKeyEnc: "x",
  apiSecretEnc: "x",
  apiPassphraseEnc: "x",
  permissions: {},
  lastSyncedAt: null,
  lastSyncError: null,
  lastTradesSyncAt: null,
  lastTradesSyncError: null,
  lastInternalTransfersSyncAt: null,
  lastInternalTransfersSyncError: null,
  archivedAt: null,
  createdAt: new Date(),
};

function trade(args: {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  amount: string;
  cost: string;
}): CexTradeRow {
  return {
    id: args.id,
    cexAccountId: "acc-1",
    exchangeTradeId: args.id,
    symbol: args.symbol,
    side: args.side,
    amount: args.amount,
    price: "0",
    cost: args.cost,
    feeCurrency: null,
    feeAmount: null,
    taker: null,
    executedAt: new Date(1000),
    createdAt: new Date(1000),
  };
}

function transfer(args: {
  id: string;
  direction: "deposit" | "withdrawal";
  asset: string;
  amount: string;
}): CexTransferRow {
  return {
    id: args.id,
    cexAccountId: "acc-1",
    exchangeTransferId: args.id,
    direction: args.direction,
    asset: args.asset,
    amount: args.amount,
    feeAmount: null,
    feeCurrency: null,
    network: null,
    address: null,
    txHash: "0xfake",
    status: "ok",
    executedAt: new Date(1000),
    createdAt: new Date(1000),
  };
}

describe("CexAssetGapService — UCB Bob-test fix #5", () => {
  it("empty user → empty gaps", async () => {
    const repo = makeRepo({ accounts: [] });
    const svc = new CexAssetGapService(repo);
    expect(await svc.detectForUser("u1")).toEqual([]);
  });

  it("Bob-like LTC scenario: 16 buys/156 sells без deposits → ERROR gap", async () => {
    // Simplified: bought 200 LTC for $22k, sold 3000 LTC for $315k.
    const repo = makeRepo({
      accounts: [ACC],
      trades: {
        "acc-1": [
          trade({ id: "T1", symbol: "LTC/USDT", side: "buy", amount: "200", cost: "22000" }),
          trade({ id: "T2", symbol: "LTC/USDT", side: "sell", amount: "3000", cost: "315000" }),
        ],
      },
    });
    const svc = new CexAssetGapService(repo);
    const gaps = await svc.detectForUser("u1");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.asset).toBe("LTC");
    expect(gaps[0]?.severity).toBe("error");
    expect(gaps[0]?.ratio).toBeGreaterThan(10);
  });

  it("BTC: buys cover sells + withdrawals → no gap", async () => {
    const repo = makeRepo({
      accounts: [ACC],
      trades: {
        "acc-1": [
          trade({ id: "T1", symbol: "BTC/USDT", side: "buy", amount: "1.0", cost: "50000" }),
        ],
      },
      transfers: {
        "acc-1": [
          transfer({ id: "WD1", direction: "withdrawal", asset: "BTC", amount: "0.5" }),
        ],
      },
    });
    const svc = new CexAssetGapService(repo);
    const gaps = await svc.detectForUser("u1");
    expect(gaps).toEqual([]);
  });

  it("deposits cover trade-side sells → no gap", async () => {
    const repo = makeRepo({
      accounts: [ACC],
      trades: {
        "acc-1": [
          trade({ id: "T1", symbol: "LTC/USDT", side: "sell", amount: "100", cost: "10000" }),
        ],
      },
      transfers: {
        "acc-1": [
          transfer({ id: "DEP1", direction: "deposit", asset: "LTC", amount: "200" }),
        ],
      },
    });
    const svc = new CexAssetGapService(repo);
    const gaps = await svc.detectForUser("u1");
    expect(gaps).toEqual([]);
  });

  it("aggregates по 2 CEX accounts user'а", async () => {
    const ACC2 = { ...ACC, id: "acc-2", exchange: "bybit" };
    const repo = {
      async listActiveForUser() { return [ACC, ACC2]; },
      async listTradesForAccount(id: string) {
        return id === "acc-1"
          ? [trade({ id: "T1", symbol: "ETH/USDT", side: "sell", amount: "1", cost: "3000" })]
          : [trade({ id: "T2", symbol: "ETH/USDT", side: "sell", amount: "0.5", cost: "1500" })];
      },
      async listTransfersForAccountAsc() { return []; },
    } as unknown as CexRepository;
    const svc = new CexAssetGapService(repo);
    const gaps = await svc.detectForUser("u1");
    // Aggregate ETH outflow = 1.5, inflow = 0 → no_acquisitions error.
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.asset).toBe("ETH");
    expect(gaps[0]?.kind).toBe("no_acquisitions_at_all");
  });

  it("ignores stable assets", async () => {
    const repo = makeRepo({
      accounts: [ACC],
      transfers: {
        "acc-1": [
          transfer({ id: "WD1", direction: "withdrawal", asset: "USDT", amount: "30000" }),
        ],
      },
    });
    const svc = new CexAssetGapService(repo);
    expect(await svc.detectForUser("u1")).toEqual([]);
  });
});
