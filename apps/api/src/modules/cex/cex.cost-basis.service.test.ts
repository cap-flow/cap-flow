import { describe, expect, it } from "vitest";

import { CexCostBasisService } from "./cex.cost-basis.service.js";
import type {
  CexAccountRow,
  CexP2pOrderRow,
  CexRepository,
  CexTradeRow,
  CexTransferRow,
} from "./cex.repository.js";

/**
 * Cost-basis chain math, pinned with synthetic scenarios from real
 * user flows (described by the user 2026-05-14):
 *   1. Fiat (RUB) → P2P-buy USDT → trade USDT/BTC → withdraw BTC
 *      to non-custodial wallet. The on-chain wallet should inherit
 *      the USD cost.
 *   2. Cold wallet → deposit ETH → trade ETH/USDT → withdraw USDT
 *      somewhere else. Stablecoin approximation kicks in.
 *   3. Deposit ETH → withdraw ETH (passthrough). Zero cost basis
 *      because we don't know what the on-chain wallet paid for it.
 */

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
  exchange: "bitget",
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

function transfer(args: {
  id: string;
  direction: "deposit" | "withdrawal";
  asset: string;
  amount: string;
  txHash: string | null;
  ts: number;
  feeAmount?: string | null;
  feeCurrency?: string | null;
}): CexTransferRow {
  return {
    id: args.id,
    cexAccountId: "acc-1",
    exchangeTransferId: args.id,
    direction: args.direction,
    asset: args.asset,
    amount: args.amount,
    feeAmount: args.feeAmount ?? null,
    feeCurrency: args.feeCurrency ?? null,
    network: null,
    address: null,
    txHash: args.txHash,
    status: "ok",
    executedAt: new Date(args.ts),
    createdAt: new Date(args.ts),
  };
}

describe("CexCostBasisService.computeForUser — fiat → P2P → trade → withdrawal", () => {
  it("propagates USD cost from P2P USDT-buy through a trade to a BTC withdrawal", async () => {
    // User invested $100 (paid 9550 RUB for 100 USDT via P2P).
    // Traded 100 USDT for 0.0014 BTC (cost = 100 USDT).
    // Withdrew 0.0014 BTC to non-custodial wallet.
    const repo = makeRepo({
      accounts: [ACC],
      p2p: {
        "acc-1": [
          p2p({
            id: "P2P-1",
            side: "buy",
            asset: "USDT",
            amount: "100",
            fiatCurrency: "RUB",
            fiatAmount: "9550",
            ts: 1000,
          }),
        ],
      },
      trades: {
        "acc-1": [
          trade({
            id: "T-1",
            symbol: "BTC/USDT",
            side: "buy",
            amount: "0.0014",
            cost: "100",
            ts: 2000,
          }),
        ],
      },
      transfers: {
        "acc-1": [
          transfer({
            id: "WD-1",
            direction: "withdrawal",
            asset: "BTC",
            amount: "0.0014",
            txHash: "0xdeadbeef",
            ts: 3000,
          }),
        ],
      },
    });
    const svc = new CexCostBasisService(repo);
    const out = await svc.computeForUser("u1");
    expect(out).toHaveLength(1);
    expect(out[0]!.txHash).toBe("0xdeadbeef");
    expect(out[0]!.asset).toBe("BTC");
    // 100 USDT ≈ $100 → BTC inherited $100 cost basis.
    expect(out[0]!.costBasisUsd).toBeCloseTo(100, 4);
    expect(out[0]!.source).toBe("fiat-direct");
  });

  it("falls back to stable-coin 1:1 when no P2P fiat trail exists", async () => {
    // User deposited 100 USDT then withdrew 100 USDT — no fiat data.
    // Stable-coin heuristic kicks in: cost ≈ $100.
    const repo = makeRepo({
      accounts: [ACC],
      transfers: {
        "acc-1": [
          transfer({
            id: "DEP-1",
            direction: "deposit",
            asset: "USDT",
            amount: "100",
            txHash: "0xaaa",
            ts: 1000,
          }),
          transfer({
            id: "WD-1",
            direction: "withdrawal",
            asset: "USDT",
            amount: "100",
            txHash: "0xbbb",
            ts: 2000,
          }),
        ],
      },
    });
    const svc = new CexCostBasisService(repo);
    const out = await svc.computeForUser("u1");
    expect(out[0]!.costBasisUsd).toBeCloseTo(100, 4);
    expect(out[0]!.source).toBe("inherited");
  });

  it("returns source:unknown when deposit→withdraw of a non-stable with no fiat trail", async () => {
    const repo = makeRepo({
      accounts: [ACC],
      transfers: {
        "acc-1": [
          transfer({
            id: "DEP-1",
            direction: "deposit",
            asset: "ETH",
            amount: "1",
            txHash: "0xaaa",
            ts: 1000,
          }),
          transfer({
            id: "WD-1",
            direction: "withdrawal",
            asset: "ETH",
            amount: "1",
            txHash: "0xbbb",
            ts: 2000,
          }),
        ],
      },
    });
    const svc = new CexCostBasisService(repo);
    const out = await svc.computeForUser("u1");
    expect(out[0]!.costBasisUsd).toBe(0);
    expect(out[0]!.source).toBe("unknown");
  });

  // ─── UCB D1: withdrawal fees split ───────────────────────────────────
  it("D1: same-asset fee — splits cost basis between amount и fee", async () => {
    // Bought 1 BTC for $50,000. Withdrew 1 BTC with 0.001 BTC fee
    // → pool removes 1.001 BTC, cost = $50,050. Recipient gets 1 BTC
    // costBasis = $50,050 × (1/1.001) ≈ $49,950. Fee loss = $50.
    const repo = makeRepo({
      accounts: [ACC],
      trades: {
        "acc-1": [
          trade({
            id: "T-1",
            symbol: "BTC/USDT",
            side: "buy",
            amount: "1.001", // bought slightly more than 1 (need to cover fee later)
            cost: "50050",
            ts: 1000,
          }),
        ],
      },
      transfers: {
        "acc-1": [
          transfer({
            id: "WD-1",
            direction: "withdrawal",
            asset: "BTC",
            amount: "1",
            feeAmount: "0.001",
            feeCurrency: "BTC",
            txHash: "0xfee",
            ts: 2000,
          }),
        ],
      },
    });
    const svc = new CexCostBasisService(repo);
    const out = await svc.computeForUser("u1");
    expect(out).toHaveLength(1);
    expect(out[0]!.amount).toBe(1);
    // 50050 × (1/1.001) = 50000 (per-unit cost was $50000/BTC)
    expect(out[0]!.costBasisUsd).toBeCloseTo(50000, 0);
    // 50050 × (0.001/1.001) ≈ 50.0
    expect(out[0]!.feeLossUsd).toBeCloseTo(50, 1);
    expect(out[0]!.feeAmount).toBeCloseTo(0.001, 6);
    expect(out[0]!.feeAsset).toBe("BTC");
    // Invariant: costBasisUsd + feeLossUsd = totalCostRemoved
    expect(out[0]!.costBasisUsd + out[0]!.feeLossUsd).toBeCloseTo(50050, 1);
  });

  it("D1: no fee — feeLossUsd = 0, costBasis unchanged", async () => {
    const repo = makeRepo({
      accounts: [ACC],
      transfers: {
        "acc-1": [
          transfer({
            id: "DEP-1",
            direction: "deposit",
            asset: "USDT",
            amount: "100",
            txHash: "0xdep",
            ts: 1000,
          }),
          transfer({
            id: "WD-1",
            direction: "withdrawal",
            asset: "USDT",
            amount: "100",
            txHash: "0xwd",
            ts: 2000,
          }),
        ],
      },
    });
    const svc = new CexCostBasisService(repo);
    const out = await svc.computeForUser("u1");
    expect(out[0]!.feeLossUsd).toBe(0);
    expect(out[0]!.feeAmount).toBe(0);
    expect(out[0]!.feeAsset).toBe(null);
    expect(out[0]!.costBasisUsd).toBeCloseTo(100, 4);
  });

  it("D1: cross-asset fee (BNB fee for BTC withdrawal) — consumes BNB pool отдельно", async () => {
    // User topped up 1 BNB (from previous trade $500 cost), bought 1 BTC,
    // withdraws BTC paying 0.01 BNB as fee.
    const repo = makeRepo({
      accounts: [ACC],
      trades: {
        "acc-1": [
          trade({
            id: "T-BNB",
            symbol: "BNB/USDT",
            side: "buy",
            amount: "1",
            cost: "500",
            ts: 500,
          }),
          trade({
            id: "T-BTC",
            symbol: "BTC/USDT",
            side: "buy",
            amount: "1",
            cost: "50000",
            ts: 1000,
          }),
        ],
      },
      transfers: {
        "acc-1": [
          transfer({
            id: "WD-1",
            direction: "withdrawal",
            asset: "BTC",
            amount: "1",
            feeAmount: "0.01",
            feeCurrency: "BNB",
            txHash: "0xwd",
            ts: 2000,
          }),
        ],
      },
    });
    const svc = new CexCostBasisService(repo);
    const out = await svc.computeForUser("u1");
    expect(out[0]!.amount).toBe(1);
    expect(out[0]!.costBasisUsd).toBeCloseTo(50000, 0);
    expect(out[0]!.feeAsset).toBe("BNB");
    // 0.01 BNB × $500/BNB pool WAC = $5 fee loss
    expect(out[0]!.feeLossUsd).toBeCloseTo(5, 1);
  });

  it("D1: stable fee with no pool history — approximates 1:1", async () => {
    // User deposited 1 BTC fresh (no cost basis), withdraws with
    // 5 USDT flat fee but never had USDT pool. Stable approximation
    // gives feeLossUsd = $5.
    const repo = makeRepo({
      accounts: [ACC],
      transfers: {
        "acc-1": [
          transfer({
            id: "DEP-1",
            direction: "deposit",
            asset: "BTC",
            amount: "1",
            txHash: "0xdep",
            ts: 1000,
          }),
          transfer({
            id: "WD-1",
            direction: "withdrawal",
            asset: "BTC",
            amount: "1",
            feeAmount: "5",
            feeCurrency: "USDT",
            txHash: "0xwd",
            ts: 2000,
          }),
        ],
      },
    });
    const svc = new CexCostBasisService(repo);
    const out = await svc.computeForUser("u1");
    expect(out[0]!.feeAsset).toBe("USDT");
    expect(out[0]!.feeLossUsd).toBeCloseTo(5, 4);
  });

  // ─── UCB C1 S3: deposit seeding ───────────────────────────────────────
  it("C1: deposit seed > $0 default — non-stable deposit inherits cost", async () => {
    // User deposits 1 ETH from on-chain (no fiat trail) — раньше cost=0.
    // Client заранее POSTил seed: this tx was 1 ETH @ $3000 cost basis.
    // applyDeposit должен использовать seed.
    const repo = makeRepo({
      accounts: [ACC],
      transfers: {
        "acc-1": [
          transfer({
            id: "DEP-1",
            direction: "deposit",
            asset: "ETH",
            amount: "1",
            txHash: "0xdeposit",
            ts: 1000,
          }),
          // Withdraw same ETH out — should pull the seeded $3000 cost.
          transfer({
            id: "WD-1",
            direction: "withdrawal",
            asset: "ETH",
            amount: "1",
            txHash: "0xwithdraw",
            ts: 2000,
          }),
        ],
      },
    });
    const seedsSvc = {
      resolveCostBasisByHash: async (
        _userId: string,
        _hashes: readonly string[],
      ) => new Map([["0xdeposit", 3000]]),
    };
    const svc = new CexCostBasisService(repo, undefined, seedsSvc as never);
    const out = await svc.computeForUser("u1");
    expect(out).toHaveLength(1);
    expect(out[0]!.txHash).toBe("0xwithdraw");
    // Withdraw 1 ETH из pool с cost $3000 (seeded) → costBasisUsd = $3000.
    expect(out[0]!.costBasisUsd).toBeCloseTo(3000, 2);
    // Seed = exact USD math (client computed via lot tracker) → 'fiat-direct'.
    expect(out[0]!.source).toBe("fiat-direct");
  });

  it("C1: deposit без seed → fallback на current behavior (cost=0)", async () => {
    const repo = makeRepo({
      accounts: [ACC],
      transfers: {
        "acc-1": [
          transfer({
            id: "DEP-1",
            direction: "deposit",
            asset: "ETH",
            amount: "1",
            txHash: "0xdeposit",
            ts: 1000,
          }),
          transfer({
            id: "WD-1",
            direction: "withdrawal",
            asset: "ETH",
            amount: "1",
            txHash: "0xwithdraw",
            ts: 2000,
          }),
        ],
      },
    });
    // No seeds service injected → behaves как раньше.
    const svc = new CexCostBasisService(repo);
    const out = await svc.computeForUser("u1");
    expect(out[0]!.costBasisUsd).toBe(0);
    expect(out[0]!.source).toBe("unknown");
  });

  it("C1: seed normalized case-insensitive (upper-case в seed map)", async () => {
    const repo = makeRepo({
      accounts: [ACC],
      transfers: {
        "acc-1": [
          // Deposit с uppercase tx hash (как обычно DeBank возвращает).
          transfer({
            id: "DEP-1",
            direction: "deposit",
            asset: "BTC",
            amount: "1",
            txHash: "0xABCDEF",
            ts: 1000,
          }),
          transfer({
            id: "WD-1",
            direction: "withdrawal",
            asset: "BTC",
            amount: "1",
            txHash: "0xwithdraw",
            ts: 2000,
          }),
        ],
      },
    });
    // Service stores hashes lowercase. applyDeposit нормализует
    // tx_hash перед lookup → должно match'нуться.
    const seedsSvc = {
      resolveCostBasisByHash: async (
        _userId: string,
        _hashes: readonly string[],
      ) => new Map([["0xabcdef", 50000]]),
    };
    const svc = new CexCostBasisService(repo, undefined, seedsSvc as never);
    const out = await svc.computeForUser("u1");
    expect(out[0]!.costBasisUsd).toBeCloseTo(50000, 2);
  });

  it("C1: deposit без txHash → fallback (нет ключа для lookup)", async () => {
    const repo = makeRepo({
      accounts: [ACC],
      transfers: {
        "acc-1": [
          transfer({
            id: "DEP-1",
            direction: "deposit",
            asset: "ETH",
            amount: "1",
            txHash: null, // no hash → can't pair to seed
            ts: 1000,
          }),
          transfer({
            id: "WD-1",
            direction: "withdrawal",
            asset: "ETH",
            amount: "1",
            txHash: "0xwithdraw",
            ts: 2000,
          }),
        ],
      },
    });
    const seedsSvc = {
      resolveCostBasisByHash: async () => new Map([["0xdeposit", 3000]]),
    };
    const svc = new CexCostBasisService(repo, undefined, seedsSvc as never);
    const out = await svc.computeForUser("u1");
    // Без hash — deposit acquires cost=0, withdrawal видит source=unknown.
    expect(out[0]!.costBasisUsd).toBe(0);
  });

  it("C1: stable deposit — seed overrides default amount=USD approx", async () => {
    // У USDT deposit без trail сейчас cost ≈ amount (stable approximation).
    // Но user мог купить USDT по другой цене (например премия P2P).
    // Seed гарантирует реальный paid USD.
    const repo = makeRepo({
      accounts: [ACC],
      transfers: {
        "acc-1": [
          transfer({
            id: "DEP-1",
            direction: "deposit",
            asset: "USDT",
            amount: "100",
            txHash: "0xdeposit",
            ts: 1000,
          }),
          transfer({
            id: "WD-1",
            direction: "withdrawal",
            asset: "USDT",
            amount: "100",
            txHash: "0xwithdraw",
            ts: 2000,
          }),
        ],
      },
    });
    // Reality: user paid $105 за 100 USDT через P2P (5% premium).
    const seedsSvc = {
      resolveCostBasisByHash: async () => new Map([["0xdeposit", 105]]),
    };
    const svc = new CexCostBasisService(repo, undefined, seedsSvc as never);
    const out = await svc.computeForUser("u1");
    expect(out[0]!.costBasisUsd).toBeCloseTo(105, 2);
  });

  it("skips withdrawals without tx_hash (we can't pair them on-chain)", async () => {
    const repo = makeRepo({
      accounts: [ACC],
      transfers: {
        "acc-1": [
          transfer({
            id: "WD-1",
            direction: "withdrawal",
            asset: "USDT",
            amount: "1",
            txHash: null,
            ts: 1000,
          }),
        ],
      },
    });
    const svc = new CexCostBasisService(repo);
    expect(await svc.computeForUser("u1")).toEqual([]);
  });
});
