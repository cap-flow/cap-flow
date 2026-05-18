import { describe, expect, it, vi } from "vitest";

import {
  CexService,
  dedupP2pOrders,
  type CexServiceConfig,
  type ICexClientFactory,
} from "./cex.service.js";
import type { CexP2pOrderRow } from "./cex.repository.js";
import type { CexAccountRow, CexRepository } from "./cex.repository.js";
import type { AuditService } from "../audit/audit.service.js";
import { deriveKey } from "../admin-integrations/secret-cipher.js";
import type {
  IP2pClient,
  IP2pClientFactory,
  P2pOrderLine,
} from "./cex.p2p.types.js";

/**
 * CexService contract:
 *
 *  - `connect()` validates exchange, probes the key, refuses unreadable
 *    keys, encrypts creds, persists.
 *  - `list()` returns user's active connections WITHOUT exposing the
 *    encrypted blobs to callers (they leak nothing on their own, but
 *    keeping them server-side is best practice).
 *  - `disconnect()` archives (soft-delete) — keeps audit trail.
 *  - `sync()` pulls fresh balance + new trades since the last-known
 *    timestamp; idempotent on re-run (uses upsert).
 */

class FakeRepo {
  accounts: CexAccountRow[] = [];
  balances: Array<{ cexAccountId: string; lines: unknown[] }> = [];
  trades: Array<{ cexAccountId: string; trades: unknown[] }> = [];
  syncSuccess: string[] = [];
  syncErrors: Array<{ id: string; msg: string }> = [];
  latestTradeAt: Map<string, Date> = new Map();
  /** UCB B1: probe outcomes recorded into permissions JSONB. */
  permissionsUpdates: Array<{ id: string; permissions: Record<string, unknown> }> = [];
  /** UCB B1: trade-history sync outcomes. */
  tradesSyncSuccess: string[] = [];
  tradesSyncErrors: Array<{ id: string; msg: string }> = [];

  async insertAccount(input: {
    userId: string;
    accountId: string;
    exchange: string;
    label: string | null;
    apiKeyEnc: string;
    apiSecretEnc: string;
    apiPassphraseEnc: string | null;
    permissions: unknown;
  }): Promise<CexAccountRow> {
    const row: CexAccountRow = {
      id: `cex-${this.accounts.length + 1}`,
      userId: input.userId,
      accountId: input.accountId,
      exchange: input.exchange,
      label: input.label,
      apiKeyEnc: input.apiKeyEnc,
      apiSecretEnc: input.apiSecretEnc,
      apiPassphraseEnc: input.apiPassphraseEnc,
      permissions: input.permissions,
      lastSyncedAt: null,
      lastSyncError: null,
      lastTradesSyncAt: null,
      lastTradesSyncError: null,
      lastInternalTransfersSyncAt: null,
      lastInternalTransfersSyncError: null,
      lastLedgerSyncAt: null,
      lastLedgerSyncError: null,
      archivedAt: null,
      createdAt: new Date(),
    };
    this.accounts.push(row);
    return row;
  }

  async findActiveById(id: string, userId: string) {
    return (
      this.accounts.find(
        (a) => a.id === id && a.userId === userId && !a.archivedAt
      ) ?? null
    );
  }

  async listActiveForUser(userId: string) {
    return this.accounts.filter((a) => a.userId === userId && !a.archivedAt);
  }

  async archive(id: string, userId: string) {
    const a = this.accounts.find(
      (x) => x.id === id && x.userId === userId
    );
    if (a) (a as { archivedAt: Date | null }).archivedAt = new Date();
  }

  async markSyncSuccess(id: string) {
    this.syncSuccess.push(id);
  }

  async markSyncError(id: string, msg: string) {
    this.syncErrors.push({ id, msg });
  }

  // UCB Bob-test fix #3: fake methods for opportunistic internal-transfers
  // chain in `syncTransfers`. Tracked for explicit verification in test.
  internalSyncSuccess: string[] = [];
  internalSyncErrors: { id: string; msg: string }[] = [];

  async markInternalTransfersSyncSuccess(id: string) {
    this.internalSyncSuccess.push(id);
  }

  async markInternalTransfersSyncError(id: string, msg: string) {
    this.internalSyncErrors.push({ id, msg });
  }

  async latestInternalTransferTimestamp(_id: string): Promise<Date | null> {
    return null;
  }

  async upsertInternalTransfers(_id: string, rows: unknown[]): Promise<number> {
    return rows.length;
  }

  // UCB B4: ledger fake methods
  ledgerSyncSuccess: string[] = [];
  ledgerSyncErrors: { id: string; msg: string }[] = [];
  async markLedgerSyncSuccess(id: string) { this.ledgerSyncSuccess.push(id); }
  async markLedgerSyncError(id: string, msg: string) {
    this.ledgerSyncErrors.push({ id, msg });
  }
  async latestLedgerTimestamp(_id: string): Promise<Date | null> { return null; }
  async upsertLedgerEntries(_id: string, rows: unknown[]): Promise<number> {
    return rows.length;
  }
  async listLedger(_id: string, _limit?: number) { return []; }

  async updatePermissions(id: string, permissions: Record<string, unknown>) {
    this.permissionsUpdates.push({ id, permissions });
    const acc = this.accounts.find((a) => a.id === id);
    if (acc) (acc as { permissions: unknown }).permissions = permissions;
  }

  async markTradesSyncSuccess(id: string) {
    this.tradesSyncSuccess.push(id);
  }

  async markTradesSyncError(id: string, msg: string) {
    this.tradesSyncErrors.push({ id, msg });
  }

  async insertBalanceSnapshot(
    cexAccountId: string,
    _snapshotAt: Date,
    lines: unknown[]
  ) {
    this.balances.push({ cexAccountId, lines: [...lines] });
  }

  async latestBalanceSnapshot() {
    return [];
  }

  async upsertTrades(cexAccountId: string, trades: unknown[]) {
    this.trades.push({ cexAccountId, trades: [...trades] });
    return trades.length;
  }

  async latestTradeTimestamp(cexAccountId: string) {
    return this.latestTradeAt.get(cexAccountId) ?? null;
  }

  // P2P
  p2pOrders: Array<{ cexAccountId: string; orders: unknown[] }> = [];
  latestP2pAt: Map<string, Date> = new Map();

  async upsertP2pOrders(cexAccountId: string, orders: unknown[]) {
    this.p2pOrders.push({ cexAccountId, orders: [...orders] });
    return orders.length;
  }

  async latestP2pTimestamp(cexAccountId: string) {
    return this.latestP2pAt.get(cexAccountId) ?? null;
  }

  async listP2pOrders(_cexAccountId: string, _limit?: number) {
    return [];
  }

  async findP2pOrderById(_orderId: string) {
    return null;
  }

  async updateP2pOrderFiat(_orderId: string, _patch: unknown) {
    return undefined;
  }

  manualP2p: unknown[] = [];
  async insertManualP2pOrder(input: {
    cexAccountId: string;
    side: "buy" | "sell";
    asset: string;
    amount: number;
    fiatCurrency: string;
    fiatAmount: number;
    unitPrice: number;
    counterparty: string | null;
    paymentMethod: string | null;
    status: string;
    executedAt: Date;
  }) {
    this.manualP2p.push(input);
    return {
      id: `manual-${this.manualP2p.length}`,
      cexAccountId: input.cexAccountId,
      exchangeOrderId: `manual-${this.manualP2p.length}`,
      side: input.side,
      asset: input.asset.toUpperCase(),
      amount: input.amount.toString(),
      fiatCurrency: input.fiatCurrency.toUpperCase(),
      fiatAmount: input.fiatAmount.toString(),
      unitPrice: input.unitPrice.toString(),
      counterparty: input.counterparty,
      paymentMethod: input.paymentMethod,
      status: input.status,
      fiatSource: "manual",
      executedAt: input.executedAt,
      createdAt: new Date(),
    };
  }

  // Transfers
  transfers: Array<{ cexAccountId: string; rows: unknown[] }> = [];
  latestTransferAt: Map<string, Date> = new Map();

  async upsertTransfers(cexAccountId: string, rows: unknown[]) {
    this.transfers.push({ cexAccountId, rows: [...rows] });
    return rows.length;
  }

  async latestTransferTimestamp(cexAccountId: string) {
    return this.latestTransferAt.get(cexAccountId) ?? null;
  }

  async listTransfers(_cexAccountId: string, _limit?: number) {
    return [];
  }

  async listAllTransfersWithHashForUser(_userId: string, _limit?: number) {
    return [];
  }

  async listTradesForAccount(_cexAccountId: string) {
    return [];
  }
}

const noopAudit: AuditService = {
  log: async () => undefined,
} as unknown as AuditService;

const CFG: CexServiceConfig = {
  cipherKey: deriveKey("test-seed-of-at-least-32-chars-aaaaaaa-bbb"),
};

function makeService(args: {
  factory: ICexClientFactory;
  p2pFactory?: IP2pClientFactory;
}): { svc: CexService; repo: FakeRepo } {
  const repo = new FakeRepo();
  const svc = new CexService(
    repo as unknown as CexRepository,
    noopAudit,
    args.factory,
    CFG,
    args.p2pFactory
  );
  return { svc, repo };
}

/* ------------------------- connect ---------------------------------------- */

describe("CexService.connect", () => {
  it("refuses unsupported exchange", async () => {
    const factory: ICexClientFactory = () => {
      throw new Error("should not be called");
    };
    const { svc } = makeService({ factory });
    await expect(
      svc.connect({
        userId: "u1",
        accountId: "a1",
        exchange: "evil-cex",
        label: null,
        credentials: { apiKey: "k", apiSecret: "s" },
      })
    ).rejects.toThrow(/unsupported/i);
  });

  it("refuses a key that fails the read-permission probe", async () => {
    const factory: ICexClientFactory = () =>
      ({
        probePermissions: async () => ({
          read: false,
          trade: false,
          withdraw: false,
          unknown: false,
        }),
      }) as never;
    const { svc, repo } = makeService({ factory });
    await expect(
      svc.connect({
        userId: "u1",
        accountId: "a1",
        exchange: "bybit",
        label: null,
        credentials: { apiKey: "k", apiSecret: "s" },
      })
    ).rejects.toThrow(/read|permission/i);
    expect(repo.accounts).toHaveLength(0);
  });

  it("encrypts credentials before persisting (never stores plaintext)", async () => {
    const factory: ICexClientFactory = () =>
      ({
        probePermissions: async () => ({
          read: true,
          trade: false,
          withdraw: false,
          unknown: true,
        }),
      }) as never;
    const { svc, repo } = makeService({ factory });
    await svc.connect({
      userId: "u1",
      accountId: "a1",
      exchange: "bybit",
      label: "Main",
      credentials: { apiKey: "PLAINTEXT-KEY-XYZ", apiSecret: "PLAINTEXT-SECRET" },
    });
    expect(repo.accounts).toHaveLength(1);
    const stored = repo.accounts[0]!;
    expect(stored.apiKeyEnc).not.toContain("PLAINTEXT-KEY-XYZ");
    expect(stored.apiSecretEnc).not.toContain("PLAINTEXT-SECRET");
    expect(stored.apiKeyEnc.startsWith("enc:v1:")).toBe(true);
    expect(stored.apiSecretEnc.startsWith("enc:v1:")).toBe(true);
    expect(stored.permissions).toMatchObject({ read: true });
  });

  it("stores passphrase encrypted when provided (OKX/Bitget)", async () => {
    const factory: ICexClientFactory = () =>
      ({
        probePermissions: async () => ({
          read: true,
          trade: false,
          withdraw: false,
          unknown: true,
        }),
      }) as never;
    const { svc, repo } = makeService({ factory });
    await svc.connect({
      userId: "u1",
      accountId: "a1",
      exchange: "okx",
      label: null,
      credentials: { apiKey: "k", apiSecret: "s", apiPassphrase: "PHRASE-9876" },
    });
    expect(repo.accounts[0]!.apiPassphraseEnc).toBeTruthy();
    expect(repo.accounts[0]!.apiPassphraseEnc).not.toContain("PHRASE-9876");
  });
});

/* ------------------------- list / disconnect ------------------------------ */

describe("CexService.list / disconnect", () => {
  it("hides encrypted blobs from the returned shape", async () => {
    const factory: ICexClientFactory = () =>
      ({
        probePermissions: async () => ({
          read: true,
          trade: false,
          withdraw: false,
          unknown: true,
        }),
      }) as never;
    const { svc } = makeService({ factory });
    await svc.connect({
      userId: "u1",
      accountId: "a1",
      exchange: "bybit",
      label: "Trading",
      credentials: { apiKey: "k", apiSecret: "s" },
    });

    const list = await svc.list("u1");
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("apiKeyEnc");
    expect(list[0]).not.toHaveProperty("apiSecretEnc");
    expect(list[0]!.exchange).toBe("bybit");
    expect(list[0]!.label).toBe("Trading");
  });

  it("disconnect archives the row (soft-delete)", async () => {
    const factory: ICexClientFactory = () =>
      ({
        probePermissions: async () => ({
          read: true,
          trade: false,
          withdraw: false,
          unknown: true,
        }),
      }) as never;
    const { svc, repo } = makeService({ factory });
    const acc = await svc.connect({
      userId: "u1",
      accountId: "a1",
      exchange: "bybit",
      label: null,
      credentials: { apiKey: "k", apiSecret: "s" },
    });
    await svc.disconnect(acc.id, "u1");
    expect(repo.accounts[0]!.archivedAt).toBeInstanceOf(Date);
    const list = await svc.list("u1");
    expect(list).toHaveLength(0);
  });
});

/* ------------------------- sync ------------------------------------------- */

describe("CexService.sync", () => {
  it("fetches balance + trades and writes snapshots; marks success", async () => {
    const fetchBalance = vi.fn().mockResolvedValue({
      BTC: { free: 0.5, used: 0, total: 0.5 },
      USDT: { free: 1000, used: 0, total: 1000 },
    });
    // UCB B1.5: chunkedFetchMyTrades делает много окон по 7 дней за 3
    // года. Mock возвращает trade только на первом window, остальные
    // пустые — это реалистично (один trade в timestamp 2023-11-14).
    const fetchMyTrades = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "T1",
          symbol: "BTC/USDT",
          side: "buy",
          amount: 0.1,
          price: 50000,
          cost: 5000,
          timestamp: 1700000000000,
        },
      ])
      .mockResolvedValue([]);
    const factory: ICexClientFactory = () =>
      ({
        probePermissions: async () => ({
          read: true,
          trade: false,
          withdraw: false,
          unknown: true,
        }),
        fetchBalance,
        fetchMyTrades,
        has: { fetchMyTrades: true },
      }) as never;

    const { svc, repo } = makeService({ factory });
    const acc = await svc.connect({
      userId: "u1",
      accountId: "a1",
      exchange: "bybit",
      label: null,
      credentials: { apiKey: "k", apiSecret: "s" },
    });

    const result = await svc.sync(acc.id, "u1");

    expect(result.balanceCount).toBe(2);
    expect(result.newTrades).toBe(1);
    expect(repo.balances).toHaveLength(1);
    expect(repo.balances[0]!.lines).toHaveLength(2);
    expect(repo.trades).toHaveLength(1);
    expect(repo.syncSuccess).toContain(acc.id);
  });

  it("records error on auth failure but does not throw", async () => {
    const factory: ICexClientFactory = () =>
      ({
        probePermissions: async () => ({
          read: true,
          trade: false,
          withdraw: false,
          unknown: true,
        }),
        fetchBalance: vi
          .fn()
          .mockRejectedValue(new Error("Authentication failed")),
      }) as never;
    const { svc, repo } = makeService({ factory });
    const acc = await svc.connect({
      userId: "u1",
      accountId: "a1",
      exchange: "bybit",
      label: null,
      credentials: { apiKey: "k", apiSecret: "s" },
    });
    const r = await svc.sync(acc.id, "u1");
    expect(r.ok).toBe(false);
    expect(repo.syncErrors).toHaveLength(1);
    expect(repo.syncErrors[0]!.msg).toMatch(/auth/i);
  });

  it("rejects sync of a non-existent / other-user's account (404 semantics)", async () => {
    const factory: ICexClientFactory = () => ({}) as never;
    const { svc } = makeService({ factory });
    await expect(svc.sync("nonexistent", "u1")).rejects.toThrow();
  });

  it("continues per-symbol loop past Bitget's 'does not have market symbol' wording", async () => {
    // Real Bitget message we hit on 2026-05-14 with a dust account
    // containing EVMOS (unlisted) + BTC (listed). The loop used to
    // throw on the EVMOS error and abandon the rest; this test pins
    // the regex to keep iterating.
    const fetchMyTrades = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error("bitget fetchMyTrades() requires a symbol argument");
      })
      .mockImplementation(async (symbol: string) => {
        if (symbol === "EVMOS/USDT") {
          throw new Error("bitget does not have market symbol EVMOS/USDT");
        }
        if (symbol === "BTC/USDT") {
          return [
            {
              id: "BT2",
              symbol: "BTC/USDT",
              side: "buy",
              amount: 0.0001,
              price: 60000,
              cost: 6,
              timestamp: 1700000000000,
            },
          ];
        }
        return [];
      });
    const factory: ICexClientFactory = () =>
      ({
        probePermissions: async () => ({
          read: true,
          trade: false,
          withdraw: false,
          unknown: true,
        }),
        fetchBalance: async () => ({
          EVMOS: { free: 0.001, used: 0, total: 0.001 },
          BTC: { free: 0.0001, used: 0, total: 0.0001 },
        }),
        fetchMyTrades,
        has: { fetchMyTrades: true },
      }) as never;

    const { svc } = makeService({ factory });
    const acc = await svc.connect({
      userId: "u1",
      accountId: "a1",
      exchange: "bitget",
      label: null,
      credentials: { apiKey: "k", apiSecret: "s", apiPassphrase: "p" },
    });
    const r = await svc.sync(acc.id, "u1");

    expect(r.ok).toBe(true);
    expect(r.newTrades).toBe(1);
    expect(r.tradesWarning).toBeUndefined();
  });

  it("falls back to per-symbol fetchMyTrades when exchange requires a symbol (Bitget)", async () => {
    // First call (no symbol) rejects with the canonical Bitget message;
    // subsequent per-symbol calls succeed for BTC/USDT, return [] for
    // the rest. Balance has BTC + USDT, so we iterate exactly once.
    const fetchMyTrades = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error("bitget fetchMyTrades() requires a symbol argument");
      })
      .mockImplementation(async (symbol: string) => {
        if (symbol === "BTC/USDT") {
          return [
            {
              id: "BT1",
              symbol: "BTC/USDT",
              side: "buy",
              amount: 0.01,
              price: 50000,
              cost: 500,
              timestamp: 1700000000000,
            },
          ];
        }
        return [];
      });
    const factory: ICexClientFactory = () =>
      ({
        probePermissions: async () => ({
          read: true,
          trade: false,
          withdraw: false,
          unknown: true,
        }),
        fetchBalance: async () => ({
          BTC: { free: 0.01, used: 0, total: 0.01 },
          USDT: { free: 1, used: 0, total: 1 },
        }),
        fetchMyTrades,
        has: { fetchMyTrades: true },
      }) as never;

    const { svc, repo } = makeService({ factory });
    const acc = await svc.connect({
      userId: "u1",
      accountId: "a1",
      exchange: "bitget",
      label: null,
      credentials: { apiKey: "k", apiSecret: "s", apiPassphrase: "p" },
    });
    const r = await svc.sync(acc.id, "u1");

    expect(r.ok).toBe(true);
    expect(r.balanceCount).toBe(2);
    expect(r.newTrades).toBe(1);
    expect(r.tradesWarning).toBeUndefined();
    expect(repo.balances).toHaveLength(1);
    // First failed call + at least one per-symbol call.
    expect(fetchMyTrades.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("returns balance success + tradesWarning when trade fetch fails non-recoverably", async () => {
    const factory: ICexClientFactory = () =>
      ({
        probePermissions: async () => ({
          read: true,
          trade: false,
          withdraw: false,
          unknown: true,
        }),
        fetchBalance: async () => ({
          BTC: { free: 0.5, used: 0, total: 0.5 },
        }),
        fetchMyTrades: vi
          .fn()
          .mockRejectedValue(new Error("Rate limit exceeded")),
        has: { fetchMyTrades: true },
      }) as never;

    const { svc, repo } = makeService({ factory });
    const acc = await svc.connect({
      userId: "u1",
      accountId: "a1",
      exchange: "bybit",
      label: null,
      credentials: { apiKey: "k", apiSecret: "s" },
    });
    const r = await svc.sync(acc.id, "u1");

    expect(r.ok).toBe(true);
    expect(r.balanceCount).toBe(1);
    expect(r.newTrades).toBe(0);
    expect(r.tradesWarning).toMatch(/Rate limit/);
    expect(repo.balances).toHaveLength(1);
    expect(repo.syncSuccess).toContain(acc.id);
  });
});

/* ─── B1.2: trades sync diagnostics persisted separately ─── */

describe("CexService.sync — trade-history diagnostics (UCB B1.2)", () => {
  it("refreshes permissions on every sync via probe (no stale state)", async () => {
    // На connect мы пробили permissions один раз. При следующем sync
    // ключ мог быть пере-issued юзером с другими permission'ами — мы
    // должны re-probe и обновить permissions в БД, а не использовать
    // старое значение.
    const probePermissions = vi
      .fn()
      .mockResolvedValueOnce({
        read: true,
        trade: false,
        withdraw: false,
        unknown: false,
        tradeHistory: "denied",
        deposits: "denied",
        withdrawals: "ok",
        lastProbedAt: "2026-05-15T10:00:00Z",
      })
      .mockResolvedValueOnce({
        read: true,
        trade: false,
        withdraw: false,
        unknown: false,
        tradeHistory: "ok",
        deposits: "ok",
        withdrawals: "ok",
        lastProbedAt: "2026-05-15T11:00:00Z",
      });
    const factory: ICexClientFactory = () =>
      ({
        probePermissions,
        fetchBalance: async () => ({}),
        fetchMyTrades: async () => [],
        has: { fetchMyTrades: true },
      }) as never;

    const { svc, repo } = makeService({ factory });
    const acc = await svc.connect({
      userId: "u1",
      accountId: "a1",
      exchange: "bybit",
      label: null,
      credentials: { apiKey: "k", apiSecret: "s" },
    });

    await svc.sync(acc.id, "u1");

    // `connect` пишет permissions через `insertAccount` (не через
    // `updatePermissions`), а `sync` — через `updatePermissions`. Так
    // что после sync в `permissionsUpdates` будет минимум 1 запись —
    // снимок с свежего probe'а (второй вызов, tradeHistory='ok').
    expect(repo.permissionsUpdates.length).toBeGreaterThanOrEqual(1);
    const last = repo.permissionsUpdates.at(-1)!;
    expect(last.permissions).toMatchObject({
      tradeHistory: "ok",
      deposits: "ok",
    });
  });

  it("skips fetchMyTrades when permissions.tradeHistory='denied' and records actionable error", async () => {
    // Точный сценарий Bob: BingX permission на trade history off.
    // Не дёргаем fetchMyTrades бессмысленно — сразу пишем понятный
    // error в last_trades_sync_error.
    const fetchMyTrades = vi.fn();
    const factory: ICexClientFactory = () =>
      ({
        probePermissions: async () => ({
          read: true,
          trade: false,
          withdraw: false,
          unknown: false,
          tradeHistory: "denied",
          deposits: "ok",
          withdrawals: "ok",
        }),
        fetchBalance: async () => ({
          BTC: { free: 0.18, used: 0, total: 0.18 },
        }),
        fetchMyTrades,
        has: { fetchMyTrades: true },
      }) as never;

    const { svc, repo } = makeService({ factory });
    const acc = await svc.connect({
      userId: "u1",
      accountId: "a1",
      exchange: "bingx",
      label: null,
      credentials: { apiKey: "k", apiSecret: "s" },
    });
    const r = await svc.sync(acc.id, "u1");

    expect(r.ok).toBe(true); // balance OK — overall sync проходит
    expect(r.newTrades).toBe(0);
    expect(fetchMyTrades).not.toHaveBeenCalled(); // не дёргаем
    expect(repo.tradesSyncErrors).toHaveLength(1);
    expect(repo.tradesSyncErrors[0]!.msg).toMatch(/permission/i);
    expect(repo.tradesSyncSuccess).toHaveLength(0);
  });

  it("records markTradesSyncSuccess when trades fetched OK (even if empty array)", async () => {
    // tradeHistory='ok' + пустой массив = mission accomplished.
    // last_trades_sync_at должен обновиться, last_trades_sync_error
    // очиститься.
    const factory: ICexClientFactory = () =>
      ({
        probePermissions: async () => ({
          read: true,
          trade: false,
          withdraw: false,
          unknown: false,
          tradeHistory: "ok",
          deposits: "ok",
          withdrawals: "ok",
        }),
        fetchBalance: async () => ({}),
        fetchMyTrades: async () => [],
        has: { fetchMyTrades: true },
      }) as never;

    const { svc, repo } = makeService({ factory });
    const acc = await svc.connect({
      userId: "u1",
      accountId: "a1",
      exchange: "bybit",
      label: null,
      credentials: { apiKey: "k", apiSecret: "s" },
    });
    await svc.sync(acc.id, "u1");

    expect(repo.tradesSyncSuccess).toContain(acc.id);
    expect(repo.tradesSyncErrors).toHaveLength(0);
  });

  it("records markTradesSyncError when fetchMyTrades throws non-recoverable", async () => {
    // Был permission ok при probe, но в ходе sync — rate limit / 5xx
    // от биржи. Пишем error в trades-channel, общий sync не падает
    // (balance OK).
    const factory: ICexClientFactory = () =>
      ({
        probePermissions: async () => ({
          read: true,
          trade: false,
          withdraw: false,
          unknown: false,
          tradeHistory: "ok",
          deposits: "ok",
          withdrawals: "ok",
        }),
        fetchBalance: async () => ({}),
        fetchMyTrades: vi
          .fn()
          .mockRejectedValue(new Error("Rate limit exceeded (429)")),
        has: { fetchMyTrades: true },
      }) as never;

    const { svc, repo } = makeService({ factory });
    const acc = await svc.connect({
      userId: "u1",
      accountId: "a1",
      exchange: "bybit",
      label: null,
      credentials: { apiKey: "k", apiSecret: "s" },
    });
    const r = await svc.sync(acc.id, "u1");

    expect(r.ok).toBe(true);
    expect(repo.tradesSyncErrors).toHaveLength(1);
    expect(repo.tradesSyncErrors[0]!.msg).toMatch(/rate limit/i);
    expect(repo.tradesSyncSuccess).toHaveLength(0);
  });

  it("tradesSyncError на permission denied содержит actionable hint", async () => {
    // Сообщение должно быть на русском, начинаться с «Trade history»
    // (узнаваемый ярлык для UI), упоминать что нужно re-issue API key.
    const factory: ICexClientFactory = () =>
      ({
        probePermissions: async () => ({
          read: true,
          trade: false,
          withdraw: false,
          unknown: false,
          tradeHistory: "denied",
          deposits: "ok",
          withdrawals: "ok",
        }),
        fetchBalance: async () => ({}),
        fetchMyTrades: async () => [],
        has: { fetchMyTrades: true },
      }) as never;
    const { svc, repo } = makeService({ factory });
    const acc = await svc.connect({
      userId: "u1",
      accountId: "a1",
      exchange: "bingx",
      label: null,
      credentials: { apiKey: "k", apiSecret: "s" },
    });
    await svc.sync(acc.id, "u1");

    const msg = repo.tradesSyncErrors[0]!.msg;
    expect(msg).toMatch(/permission|trade history|API/i);
  });

  it("balance ok + tradeHistory='unsupported' — skip without error", async () => {
    // Биржа просто не имеет fetchMyTrades в CCXT. Не error, не warning —
    // нормальное «not applicable». tradesSyncError остаётся null.
    const factory: ICexClientFactory = () =>
      ({
        probePermissions: async () => ({
          read: true,
          trade: false,
          withdraw: false,
          unknown: false,
          tradeHistory: "unsupported",
          deposits: "ok",
          withdrawals: "ok",
        }),
        fetchBalance: async () => ({}),
        has: { fetchMyTrades: false },
      }) as never;
    const { svc, repo } = makeService({ factory });
    const acc = await svc.connect({
      userId: "u1",
      accountId: "a1",
      exchange: "bybit",
      label: null,
      credentials: { apiKey: "k", apiSecret: "s" },
    });
    await svc.sync(acc.id, "u1");

    expect(repo.tradesSyncErrors).toHaveLength(0);
    expect(repo.tradesSyncSuccess).toHaveLength(0);
  });
});

/* ------------------------- syncP2p --------------------------------------- */

const passingSpotFactory: ICexClientFactory = () =>
  ({
    probePermissions: async () => ({
      read: true,
      trade: false,
      withdraw: false,
      unknown: true,
    }),
  }) as never;

function makeFakeP2pClient(orders: P2pOrderLine[]): IP2pClient {
  return {
    exchange: "bitget",
    fetchP2pOrders: vi.fn().mockResolvedValue(orders),
  };
}

describe("CexService.syncP2p", () => {
  it("reports supported:false when no P2P factory is wired", async () => {
    const { svc } = makeService({ factory: passingSpotFactory });
    const acc = await svc.connect({
      userId: "u1",
      accountId: "a1",
      exchange: "bitget",
      label: null,
      credentials: { apiKey: "k", apiSecret: "s", apiPassphrase: "p" },
    });
    const r = await svc.syncP2p(acc.id, "u1");
    expect(r.supported).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.newOrders).toBe(0);
  });

  it("reports supported:false when the factory returns null for this exchange", async () => {
    const p2pFactory: IP2pClientFactory = () => null;
    const { svc } = makeService({
      factory: passingSpotFactory,
      p2pFactory,
    });
    const acc = await svc.connect({
      userId: "u1",
      accountId: "a1",
      exchange: "bybit",
      label: null,
      credentials: { apiKey: "k", apiSecret: "s" },
    });
    const r = await svc.syncP2p(acc.id, "u1");
    expect(r.supported).toBe(false);
  });

  it("pulls + upserts P2P orders when the adapter exists", async () => {
    const orders: P2pOrderLine[] = [
      {
        id: "P2P-1",
        side: "buy",
        asset: "USDT",
        amount: 1000,
        fiatCurrency: null,
        fiatAmount: null,
        unitPrice: null,
        counterparty: null,
        paymentMethod: null,
        status: "completed",
        executedAtMs: 1700000000000,
      },
    ];
    const p2pFactory: IP2pClientFactory = () => makeFakeP2pClient(orders);
    const { svc, repo } = makeService({
      factory: passingSpotFactory,
      p2pFactory,
    });
    const acc = await svc.connect({
      userId: "u1",
      accountId: "a1",
      exchange: "bitget",
      label: null,
      credentials: { apiKey: "k", apiSecret: "s", apiPassphrase: "p" },
    });
    const r = await svc.syncP2p(acc.id, "u1");

    expect(r.supported).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.newOrders).toBe(1);
    expect(repo.p2pOrders).toHaveLength(1);
    expect(repo.p2pOrders[0]!.orders).toHaveLength(1);
  });

  it("returns ok:false with error message when the adapter throws (e.g. P2P scope missing)", async () => {
    const p2pFactory: IP2pClientFactory = () => ({
      exchange: "bitget" as const,
      fetchP2pOrders: vi
        .fn()
        .mockRejectedValue(new Error("Bitget P2P error code=40037")),
    });
    const { svc } = makeService({
      factory: passingSpotFactory,
      p2pFactory,
    });
    const acc = await svc.connect({
      userId: "u1",
      accountId: "a1",
      exchange: "bitget",
      label: null,
      credentials: { apiKey: "k", apiSecret: "s", apiPassphrase: "p" },
    });
    const r = await svc.syncP2p(acc.id, "u1");

    expect(r.supported).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/40037/);
  });

  it("throws NotFound when the account doesn't belong to the user", async () => {
    const p2pFactory: IP2pClientFactory = () => null;
    const { svc } = makeService({
      factory: passingSpotFactory,
      p2pFactory,
    });
    await expect(svc.syncP2p("does-not-exist", "u1")).rejects.toThrow();
  });
});

/* ------------------------- dedupP2pOrders ------------------------------- */

function p2pRow(args: {
  id: string;
  side: "buy" | "sell";
  asset: string;
  amount: string;
  executedAtMs: number;
}): CexP2pOrderRow {
  return {
    id: args.id,
    cexAccountId: "cex-1",
    exchangeOrderId: args.id,
    side: args.side,
    asset: args.asset,
    amount: args.amount,
    fiatCurrency: null,
    fiatAmount: null,
    unitPrice: null,
    counterparty: null,
    paymentMethod: null,
    status: "completed",
    executedAt: new Date(args.executedAtMs),
    createdAt: new Date(args.executedAtMs),
    fiatSource: "api",
  };
}

describe("dedupP2pOrders", () => {
  it("collapses Bitget's 3-row-per-trade journal into one canonical row", () => {
    // Real shape from user 9a93d…fd83 on 2026-04-25: one logical sale
    // surfaced as three rows over 5 minutes with overlapping amounts.
    const rows: CexP2pOrderRow[] = [
      p2pRow({ id: "r3", side: "sell", asset: "USDT", amount: "187.94298965", executedAtMs: 1740000060000 }),
      p2pRow({ id: "r2", side: "sell", asset: "USDT", amount: "187.94298965", executedAtMs: 1740000030000 }),
      p2pRow({ id: "r1", side: "sell", asset: "USDT", amount: "187.90000000", executedAtMs: 1740000000000 }),
    ];
    const out = dedupP2pOrders(rows);
    expect(out).toHaveLength(1);
    expect(out[0]!.mergedCount).toBe(3);
    // Canonical pick = largest amount (gross leg).
    expect(Number(out[0]!.amount)).toBeCloseTo(187.94298965);
  });

  it("keeps independent trades separated when more than 15 min apart", () => {
    const rows: CexP2pOrderRow[] = [
      p2pRow({ id: "r2", side: "sell", asset: "USDT", amount: "200", executedAtMs: 1740000000000 + 16 * 60 * 1000 }),
      p2pRow({ id: "r1", side: "sell", asset: "USDT", amount: "100", executedAtMs: 1740000000000 }),
    ];
    const out = dedupP2pOrders(rows);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.mergedCount)).toEqual([1, 1]);
  });

  it("does not merge across asset or side", () => {
    const rows: CexP2pOrderRow[] = [
      p2pRow({ id: "r3", side: "buy",  asset: "USDT", amount: "100", executedAtMs: 1740000060000 }),
      p2pRow({ id: "r2", side: "sell", asset: "BTC",  amount: "0.001", executedAtMs: 1740000030000 }),
      p2pRow({ id: "r1", side: "sell", asset: "USDT", amount: "100", executedAtMs: 1740000000000 }),
    ];
    const out = dedupP2pOrders(rows);
    expect(out).toHaveLength(3);
  });

  it("returns empty array on empty input", () => {
    expect(dedupP2pOrders([])).toEqual([]);
  });
});

/* ------------------------- syncTransfers --------------------------------- */

describe("CexService.syncTransfers", () => {
  it("pulls both deposits and withdrawals; counts each direction separately", async () => {
    // UCB B2: chunked-fetch. Mock returns data only on first window.
    const fetchDeposits = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "DEP-1",
          txid: "0xdeadbeef",
          type: "deposit",
          currency: "ETH",
          amount: "0.015",
          address: "0xBitgetDeposit",
          network: "ETH",
          status: "ok",
          timestamp: 1700000000000,
        },
      ])
      .mockResolvedValue([]);
    // UCB B2: chunked-fetch делает много окон. Mock возвращает data на
    // первом окне, остальные пустые.
    const fetchWithdrawals = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "WD-1",
          txid: "0xcafebabe",
          type: "withdrawal",
          currency: "ETH",
          amount: "0.01",
          address: "0xMyWallet",
          network: "ETH",
          fee: { cost: "0.0001", currency: "ETH" },
          status: "ok",
          timestamp: 1700000010000,
        },
      ])
      .mockResolvedValue([]);
    const factory: ICexClientFactory = () =>
      ({
        probePermissions: async () => ({
          read: true,
          trade: false,
          withdraw: false,
          unknown: true,
        }),
        fetchDeposits,
        fetchWithdrawals,
      }) as never;
    const { svc, repo } = makeService({ factory });
    const acc = await svc.connect({
      userId: "u1",
      accountId: "a1",
      exchange: "bitget",
      label: null,
      credentials: { apiKey: "k", apiSecret: "s", apiPassphrase: "p" },
    });
    const r = await svc.syncTransfers(acc.id, "u1");
    expect(r.ok).toBe(true);
    expect(r.newDeposits).toBe(1);
    expect(r.newWithdrawals).toBe(1);
    expect(repo.transfers).toHaveLength(2);
  });

  it("succeeds partially when one direction fails", async () => {
    const factory: ICexClientFactory = () =>
      ({
        probePermissions: async () => ({
          read: true,
          trade: false,
          withdraw: false,
          unknown: true,
        }),
        // UCB B2: chunked-fetch — data только на первом окне.
        fetchDeposits: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: "DEP-1",
              txid: "0xabc",
              type: "deposit",
              currency: "ETH",
              amount: "0.01",
              status: "ok",
              timestamp: 1700000000000,
            },
          ])
          .mockResolvedValue([]),
        // Все окна reject → ChunkedFetchResult.errors не empty,
        // newWithdrawals = 0, error = первое сообщение.
        fetchWithdrawals: vi
          .fn()
          .mockRejectedValue(new Error("withdrawal history not supported")),
      }) as never;
    const { svc } = makeService({ factory });
    const acc = await svc.connect({
      userId: "u1",
      accountId: "a1",
      exchange: "bybit",
      label: null,
      credentials: { apiKey: "k", apiSecret: "s" },
    });
    const r = await svc.syncTransfers(acc.id, "u1");
    expect(r.ok).toBe(false);
    expect(r.newDeposits).toBe(1);
    expect(r.newWithdrawals).toBe(0);
    expect(r.error).toMatch(/withdrawal history not supported/);
  });

  // Bug fix (UCB Bob test #1): partial sync failure must persist
  // last_sync_error so Sync Coverage UI surfaces the problem instead
  // of showing "OK" silently.
  it("persists last_sync_error via markSyncError on partial failure", async () => {
    const factory: ICexClientFactory = () =>
      ({
        probePermissions: async () => ({
          read: true,
          trade: false,
          withdraw: false,
          unknown: true,
        }),
        fetchDeposits: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: "DEP-1",
              txid: "0xabc",
              type: "deposit",
              currency: "ETH",
              amount: "0.01",
              status: "ok",
              timestamp: 1700000000000,
            },
          ])
          .mockResolvedValue([]),
        fetchWithdrawals: vi
          .fn()
          .mockRejectedValue(new Error("withdrawal history not supported")),
      }) as never;
    const { svc, repo } = makeService({ factory });
    const acc = await svc.connect({
      userId: "u1",
      accountId: "a1",
      exchange: "bybit",
      label: null,
      credentials: { apiKey: "k", apiSecret: "s" },
    });
    repo.syncErrors.length = 0; // clear from any earlier sync
    const r = await svc.syncTransfers(acc.id, "u1");
    expect(r.ok).toBe(false);
    expect(repo.syncErrors).toHaveLength(1);
    expect(repo.syncErrors[0]?.id).toBe(acc.id);
    expect(repo.syncErrors[0]?.msg).toMatch(/withdrawals/);
  });

  it("clears last_sync_error via markSyncSuccess on full success", async () => {
    const factory: ICexClientFactory = () =>
      ({
        probePermissions: async () => ({
          read: true,
          trade: false,
          withdraw: false,
          unknown: true,
        }),
        fetchDeposits: vi.fn().mockResolvedValue([]),
        fetchWithdrawals: vi.fn().mockResolvedValue([]),
      }) as never;
    const { svc, repo } = makeService({ factory });
    const acc = await svc.connect({
      userId: "u1",
      accountId: "a1",
      exchange: "bybit",
      label: null,
      credentials: { apiKey: "k", apiSecret: "s" },
    });
    repo.syncSuccess.length = 0;
    const r = await svc.syncTransfers(acc.id, "u1");
    expect(r.ok).toBe(true);
    expect(repo.syncSuccess).toContain(acc.id);
  });

  it("throws NotFound when the account doesn't belong to the user", async () => {
    const factory: ICexClientFactory = () => ({}) as never;
    const { svc } = makeService({ factory });
    await expect(
      svc.syncTransfers("does-not-exist", "u1")
    ).rejects.toThrow();
  });

  // Bob test fix #3: syncTransfers opportunistically chains internal-transfers
  // sync чтобы user не должен был помнить про отдельную кнопку.
  it("opportunistically chains internal-transfers sync (fail-soft)", async () => {
    const factory: ICexClientFactory = () =>
      ({
        probePermissions: async () => ({
          read: true,
          trade: false,
          withdraw: false,
          unknown: true,
        }),
        fetchDeposits: vi.fn().mockResolvedValue([]),
        fetchWithdrawals: vi.fn().mockResolvedValue([]),
        // No fetchTransfers exposed → internal sync должна fail с
        // "fetchTransfers not supported", помечается в internal-sync state
        // отдельно, transfers sync остаётся ok=true.
      }) as never;
    const { svc, repo } = makeService({ factory });
    const acc = await svc.connect({
      userId: "u1",
      accountId: "a1",
      exchange: "bybit",
      label: null,
      credentials: { apiKey: "k", apiSecret: "s" },
    });
    repo.internalSyncErrors.length = 0;
    const r = await svc.syncTransfers(acc.id, "u1");
    // Transfers sync остаётся успешной.
    expect(r.ok).toBe(true);
    // Internal sync failed but recorded в своём namespace.
    expect(repo.internalSyncErrors).toHaveLength(1);
    expect(repo.internalSyncErrors[0]?.msg).toMatch(/fetchTransfers/);
  });
});

/* ------------------------- createManualP2pOrder ------------------------- */

describe("CexService.createManualP2pOrder", () => {
  it("inserts a manual P2P order with computed unit price", async () => {
    const factory: ICexClientFactory = () =>
      ({
        probePermissions: async () => ({
          read: true,
          trade: false,
          withdraw: false,
          unknown: true,
        }),
      }) as never;
    const { svc, repo } = makeService({ factory });
    const acc = await svc.connect({
      userId: "u1",
      accountId: "a1",
      exchange: "bingx",
      label: null,
      credentials: { apiKey: "k", apiSecret: "s" },
    });
    const out = await svc.createManualP2pOrder(acc.id, "u1", {
      side: "buy",
      asset: "USDT",
      amount: 100,
      fiatCurrency: "RUB",
      fiatAmount: 9550,
      executedAt: new Date("2026-05-01T00:00:00Z"),
    });
    expect(out.fiatSource).toBe("manual");
    expect(out.asset).toBe("USDT");
    expect(out.fiatCurrency).toBe("RUB");
    expect(Number(out.unitPrice)).toBeCloseTo(95.5, 5);
    expect(repo.manualP2p).toHaveLength(1);
  });

  it("rejects amount or fiatAmount <= 0", async () => {
    const factory: ICexClientFactory = () =>
      ({
        probePermissions: async () => ({
          read: true,
          trade: false,
          withdraw: false,
          unknown: true,
        }),
      }) as never;
    const { svc } = makeService({ factory });
    const acc = await svc.connect({
      userId: "u1",
      accountId: "a1",
      exchange: "bingx",
      label: null,
      credentials: { apiKey: "k", apiSecret: "s" },
    });
    await expect(
      svc.createManualP2pOrder(acc.id, "u1", {
        side: "buy",
        asset: "USDT",
        amount: 0,
        fiatCurrency: "RUB",
        fiatAmount: 1000,
        executedAt: new Date(),
      })
    ).rejects.toThrow(/amount/);
  });

  it("rejects unauthorized account", async () => {
    const factory: ICexClientFactory = () => ({}) as never;
    const { svc } = makeService({ factory });
    await expect(
      svc.createManualP2pOrder("nope", "u1", {
        side: "buy",
        asset: "USDT",
        amount: 1,
        fiatCurrency: "USD",
        fiatAmount: 1,
        executedAt: new Date(),
      })
    ).rejects.toThrow();
  });
});

/* ─── UCB B6: importTradesCsv — manual CSV/XLSX import for trades ─── */

describe("CexService.importTradesCsv", () => {
  function makeFactoryStub(): ICexClientFactory {
    return () =>
      ({
        probePermissions: async () => ({
          read: true,
          trade: false,
          withdraw: false,
          unknown: true,
        }),
        fetchBalance: async () => ({}),
      }) as never;
  }

  it("импортирует валидные trades через upsert (idempotent)", async () => {
    const { svc, repo } = makeService({ factory: makeFactoryStub() });
    const acc = await svc.connect({
      userId: "u1",
      accountId: "a1",
      exchange: "bybit",
      label: null,
      credentials: { apiKey: "k", apiSecret: "s" },
    });
    const r = await svc.importTradesCsv(acc.id, "u1", [
      {
        exchangeTradeId: "T-1",
        symbol: "btc/usdt", // lowercase → нормализуется в UPPER
        side: "buy",
        amount: 0.1,
        price: 50000,
        cost: 5000,
        executedAt: "2024-09-08T08:13:39+00:00",
      },
    ]);
    expect(r.inserted).toBe(1);
    expect(r.skipped).toBe(0);
    expect(r.total).toBe(1);
    expect(repo.trades[0]!.trades).toHaveLength(1);
    const t = repo.trades[0]!.trades[0] as { symbol: string };
    expect(t.symbol).toBe("BTC/USDT");
  });

  it("skipped счёт для invalid rows (zero amount, missing fields, bad date)", async () => {
    const { svc, repo } = makeService({ factory: makeFactoryStub() });
    const acc = await svc.connect({
      userId: "u1",
      accountId: "a1",
      exchange: "bybit",
      label: null,
      credentials: { apiKey: "k", apiSecret: "s" },
    });
    const r = await svc.importTradesCsv(acc.id, "u1", [
      {
        exchangeTradeId: "T-OK",
        symbol: "BTC/USDT",
        side: "buy",
        amount: 0.1,
        price: 50000,
        cost: 5000,
        executedAt: "2024-09-08T08:13:39+00:00",
      },
      // zero amount
      {
        exchangeTradeId: "T-BAD1",
        symbol: "BTC/USDT",
        side: "buy",
        amount: 0,
        price: 50000,
        cost: 0,
        executedAt: "2024-09-08T08:13:39+00:00",
      },
      // empty trade-id
      {
        exchangeTradeId: "",
        symbol: "BTC/USDT",
        side: "buy",
        amount: 0.1,
        price: 50000,
        cost: 5000,
        executedAt: "2024-09-08T08:13:39+00:00",
      },
      // wrong side
      {
        exchangeTradeId: "T-BAD3",
        symbol: "BTC/USDT",
        side: "invalid" as never,
        amount: 0.1,
        price: 50000,
        cost: 5000,
        executedAt: "2024-09-08T08:13:39+00:00",
      },
      // bad date
      {
        exchangeTradeId: "T-BAD4",
        symbol: "BTC/USDT",
        side: "buy",
        amount: 0.1,
        price: 50000,
        cost: 5000,
        executedAt: "not-a-date",
      },
    ]);
    expect(r.inserted).toBe(1);
    expect(r.skipped).toBe(4);
    expect(r.total).toBe(5);
    expect(repo.trades[0]!.trades).toHaveLength(1);
  });

  it("synthesizes cost = amount × price если cost не задан или 0", async () => {
    const { svc, repo } = makeService({ factory: makeFactoryStub() });
    const acc = await svc.connect({
      userId: "u1",
      accountId: "a1",
      exchange: "bingx",
      label: null,
      credentials: { apiKey: "k", apiSecret: "s" },
    });
    await svc.importTradesCsv(acc.id, "u1", [
      {
        exchangeTradeId: "T-NoCost",
        symbol: "SOL/USDT",
        side: "buy",
        amount: 3.13,
        price: 127.76,
        cost: 0, // missing
        executedAt: "2024-09-09T06:55:24+08:00",
      },
    ]);
    const t = repo.trades[0]!.trades[0] as { cost: number };
    expect(t.cost).toBeCloseTo(3.13 * 127.76, 4);
  });

  it("отвергает import если account другого user'а", async () => {
    const { svc } = makeService({ factory: makeFactoryStub() });
    const acc = await svc.connect({
      userId: "u1",
      accountId: "a1",
      exchange: "bybit",
      label: null,
      credentials: { apiKey: "k", apiSecret: "s" },
    });
    await expect(
      svc.importTradesCsv(acc.id, "other-user", []),
    ).rejects.toThrow(/not found/i);
  });

  it("empty rows → returns zero counts без error", async () => {
    const { svc } = makeService({ factory: makeFactoryStub() });
    const acc = await svc.connect({
      userId: "u1",
      accountId: "a1",
      exchange: "bybit",
      label: null,
      credentials: { apiKey: "k", apiSecret: "s" },
    });
    const r = await svc.importTradesCsv(acc.id, "u1", []);
    expect(r).toEqual({ inserted: 0, skipped: 0, total: 0 });
  });
});
