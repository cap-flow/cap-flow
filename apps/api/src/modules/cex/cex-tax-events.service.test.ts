/**
 * Tax T4: tests for CexTaxEventsService.
 *
 * Walks p2p + trades + transfers chronologically + same WAC pool как
 * CexCostBasisService. Emit'ит tax events ТОЛЬКО для dispositions:
 *   - P2P sell (crypto → fiat): sale event с realized USD = fiatToUsd
 *   - Trade non-stable → stable (sell side): sale event
 *   - Trade non-stable → non-stable: exchange event
 *   - Trade stable → anything: acquisition only (no event)
 *
 * Acquisitions (P2P buy / deposit / trade buy) — update pool, no event.
 */
import { describe, expect, it } from "vitest";

import { CexTaxEventsService } from "./cex-tax-events.service.js";
import type {
  CexAccountRow,
  CexP2pOrderRow,
  CexRepository,
  CexTradeRow,
  CexTransferRow,
} from "./cex.repository.js";

function makeRepo(args: {
  accounts: CexAccountRow[];
  p2p?: Record<string, CexP2pOrderRow[]>;
  trades?: Record<string, CexTradeRow[]>;
  transfers?: Record<string, CexTransferRow[]>;
}): CexRepository {
  return {
    async listActiveForUser() {
      return args.accounts;
    },
    async listP2pOrdersForAccountAsc(id: string) {
      return args.p2p?.[id] ?? [];
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
  exchange: "bybit",
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
  ts: number;
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
    executedAt: new Date(args.ts),
    createdAt: new Date(args.ts),
  };
}

function p2p(args: {
  id: string;
  side: "buy" | "sell";
  asset: string;
  amount: string;
  fiatCurrency: string | null;
  fiatAmount: string | null;
  ts: number;
}): CexP2pOrderRow {
  return {
    id: args.id,
    cexAccountId: "acc-1",
    exchangeOrderId: args.id,
    side: args.side,
    asset: args.asset,
    amount: args.amount,
    fiatCurrency: args.fiatCurrency,
    fiatAmount: args.fiatAmount,
    unitPrice: null,
    counterparty: null,
    paymentMethod: null,
    status: "completed",
    fiatSource: "manual",
    executedAt: new Date(args.ts),
    createdAt: new Date(args.ts),
  };
}

describe("CexTaxEventsService — Tax T4", () => {
  it("empty input → empty events", async () => {
    const repo = makeRepo({ accounts: [] });
    const svc = new CexTaxEventsService(repo);
    expect(await svc.generateForUser("u1")).toEqual([]);
  });

  it("trade buy BTC/USDT (acquisition) → no event", async () => {
    const repo = makeRepo({
      accounts: [ACC],
      trades: {
        "acc-1": [
          trade({
            id: "T-1",
            symbol: "BTC/USDT",
            side: "buy",
            amount: "0.01",
            cost: "500",
            ts: 1000,
          }),
        ],
      },
    });
    const svc = new CexTaxEventsService(repo);
    const events = await svc.generateForUser("u1");
    expect(events).toEqual([]);
  });

  it("trade buy then sell BTC/USDT при gain → 1 sale event", async () => {
    const repo = makeRepo({
      accounts: [ACC],
      trades: {
        "acc-1": [
          trade({
            id: "T-buy",
            symbol: "BTC/USDT",
            side: "buy",
            amount: "0.01",
            cost: "500", // 500 USDT cost
            ts: 1000,
          }),
          trade({
            id: "T-sell",
            symbol: "BTC/USDT",
            side: "sell",
            amount: "0.01",
            cost: "700", // 700 USDT proceeds
            ts: 2000,
          }),
        ],
      },
      // P2P-buy для USDT чтобы pool имел fiat trail.
      p2p: {
        "acc-1": [
          p2p({
            id: "P2P-1",
            side: "buy",
            asset: "USDT",
            amount: "500",
            fiatCurrency: "USD",
            fiatAmount: "500",
            ts: 500,
          }),
        ],
      },
    });
    const svc = new CexTaxEventsService(repo);
    const events = await svc.generateForUser("u1");
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.eventType).toBe("sale");
    expect(e.asset).toBe("BTC");
    expect(e.proceedsUsd).toBeCloseTo(700, 2);
    expect(e.costBasisUsd).toBeCloseTo(500, 2);
    expect(e.gainUsd).toBeCloseTo(200, 2);
  });

  it("P2P sell crypto → fiat: sale event с realized gain", async () => {
    const repo = makeRepo({
      accounts: [ACC],
      p2p: {
        "acc-1": [
          // P2P buy USDT с RUB сначала чтобы pool имел USDT.
          p2p({
            id: "P2P-buy",
            side: "buy",
            asset: "USDT",
            amount: "1000",
            fiatCurrency: "USD",
            fiatAmount: "1000",
            ts: 500,
          }),
          // Trade USDT/BTC чтобы pool имел BTC.
          // (Это complicated — пропускаем, используем deposit вместо)
        ],
      },
      trades: {
        "acc-1": [
          trade({
            id: "T-buy",
            symbol: "BTC/USDT",
            side: "buy",
            amount: "0.01",
            cost: "500",
            ts: 1000,
          }),
        ],
      },
      // Withdraw_fiat доступен только через P2P side="sell". Создаём
      // P2P sell BTC → RUB чтобы emit sale event.
    });
    // Add a P2P sell event
    const repoExt = {
      ...repo,
      async listP2pOrdersForAccountAsc(id: string) {
        if (id === "acc-1") {
          return [
            p2p({
              id: "P2P-buy",
              side: "buy",
              asset: "USDT",
              amount: "1000",
              fiatCurrency: "USD",
              fiatAmount: "1000",
              ts: 500,
            }),
            p2p({
              id: "P2P-sell-btc",
              side: "sell",
              asset: "BTC",
              amount: "0.01",
              fiatCurrency: "USD",
              fiatAmount: "700", // sold for $700
              ts: 2000,
            }),
          ];
        }
        return [];
      },
    } as unknown as CexRepository;
    const svc = new CexTaxEventsService(repoExt);
    const events = await svc.generateForUser("u1");
    // Should be sale event for BTC при P2P sell.
    const saleEvents = events.filter((e) => e.eventType === "sale");
    expect(saleEvents).toHaveLength(1);
    expect(saleEvents[0]?.asset).toBe("BTC");
    expect(saleEvents[0]?.proceedsUsd).toBeCloseTo(700, 2);
    expect(saleEvents[0]?.costBasisUsd).toBeCloseTo(500, 2);
    expect(saleEvents[0]?.gainUsd).toBeCloseTo(200, 2);
  });

  it("trade non-stable → non-stable (ETH/BTC sell ETH for BTC) → exchange event", async () => {
    const repo = makeRepo({
      accounts: [ACC],
      p2p: {
        "acc-1": [
          p2p({
            id: "P2P-1",
            side: "buy",
            asset: "USDT",
            amount: "2000",
            fiatCurrency: "USD",
            fiatAmount: "2000",
            ts: 500,
          }),
        ],
      },
      trades: {
        "acc-1": [
          // Buy 1 ETH for 2000 USDT
          trade({
            id: "T-1",
            symbol: "ETH/USDT",
            side: "buy",
            amount: "1",
            cost: "2000",
            ts: 1000,
          }),
          // Sell 1 ETH for 0.05 BTC (price grew, market value ~$3000)
          trade({
            id: "T-2",
            symbol: "ETH/BTC",
            side: "sell",
            amount: "1",
            cost: "0.05",
            ts: 2000,
          }),
        ],
      },
    });
    const svc = new CexTaxEventsService(repo);
    const events = await svc.generateForUser("u1");
    // ETH/BTC sell — base=ETH sold for non-stable BTC → exchange.
    const exchangeEvents = events.filter((e) => e.eventType === "exchange");
    expect(exchangeEvents.length).toBeGreaterThanOrEqual(1);
    expect(exchangeEvents[0]?.asset).toBe("ETH");
  });

  it("ignores trades без fiat-trail cost basis (gracefully)", async () => {
    // Sell BTC без prior buy → cost=0, proceeds=700, gain=700.
    const repo = makeRepo({
      accounts: [ACC],
      trades: {
        "acc-1": [
          trade({
            id: "T-sell",
            symbol: "BTC/USDT",
            side: "sell",
            amount: "0.01",
            cost: "700",
            ts: 1000,
          }),
        ],
      },
    });
    const svc = new CexTaxEventsService(repo);
    const events = await svc.generateForUser("u1");
    expect(events).toHaveLength(1);
    expect(events[0]?.costBasisUsd).toBe(0); // no prior basis
    expect(events[0]?.gainUsd).toBeCloseTo(700, 2);
  });

  it("multiple accounts: events aggregated per user", async () => {
    const ACC2: CexAccountRow = { ...ACC, id: "acc-2", exchange: "binance" };
    const repo = {
      async listActiveForUser() {
        return [ACC, ACC2];
      },
      async listP2pOrdersForAccountAsc() {
        return [];
      },
      async listTradesForAccount(id: string) {
        return id === "acc-1"
          ? [
              trade({
                id: "T-A",
                symbol: "BTC/USDT",
                side: "sell",
                amount: "0.01",
                cost: "500",
                ts: 1000,
              }),
            ]
          : [
              trade({
                id: "T-B",
                symbol: "ETH/USDT",
                side: "sell",
                amount: "1",
                cost: "2000",
                ts: 2000,
              }),
            ];
      },
      async listTransfersForAccountAsc() {
        return [];
      },
    } as unknown as CexRepository;
    const svc = new CexTaxEventsService(repo);
    const events = await svc.generateForUser("u1");
    expect(events).toHaveLength(2);
    const exchangeIds = events.map((e) => e.cexAccountId).sort();
    expect(exchangeIds).toEqual(["acc-1", "acc-2"]);
  });
});
