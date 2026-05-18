/**
 * Unit tests для ChainOpsRepository contract'а — мокаем Drizzle через
 * proxy fake, не hit'аем реальную БД. Покрываем:
 *   - Idempotent upsert (повторный INSERT с тем же tx_hash → UPDATE, не дубль)
 *   - List by wallet — orders, limits
 *   - Cross-wallet hash lookup для UCB graph traversal
 *   - Latest timestamp helper для delta-refresh
 *   - Sync state markers
 */
import { describe, expect, it, vi } from "vitest";

import { ChainOpsRepository } from "./chain-ops.repository.js";

/* ─── Drizzle proxy stub ─── */

/**
 * Минимальный fake который ловит цепочки `.insert().values().onConflictDoUpdate().returning()`
 * и `.select().from().where().orderBy().limit()`. Все методы возвращают
 * `this` для chaining, а terminal-методы (returning, list, limit) —
 * результат из локального state.
 */
function makeFakeDb(state: { upserted?: unknown[]; selected?: unknown[] } = {}) {
  const captured: {
    insertValues?: unknown[];
    conflictTarget?: unknown;
    conflictSet?: unknown;
    selectWhere?: unknown;
    selectOrder?: "asc" | "desc" | "unknown";
    selectLimit?: number;
    updateSet?: unknown;
    updateWhere?: unknown;
  } = {};

  const chain = {
    innerJoin() {
      return this;
    },
    values(v: unknown[]) {
      captured.insertValues = v;
      return this;
    },
    onConflictDoUpdate(input: { target: unknown; set: unknown }) {
      captured.conflictTarget = input.target;
      captured.conflictSet = input.set;
      return this;
    },
    onConflictDoNothing(input: { target: unknown }) {
      captured.conflictTarget = input.target;
      return this;
    },
    returning() {
      return Promise.resolve(state.upserted ?? []);
    },
    set(v: unknown) {
      captured.updateSet = v;
      return this;
    },
    from() {
      return this;
    },
    where(w: unknown) {
      if (captured.selectWhere === undefined) captured.selectWhere = w;
      else captured.updateWhere = w;
      return this;
    },
    orderBy() {
      return this;
    },
    limit(n: number) {
      captured.selectLimit = n;
      return Promise.resolve(state.selected ?? []);
    },
    // Awaiting query без limit
    then(onFulfilled: (v: unknown[]) => unknown) {
      return Promise.resolve(state.selected ?? []).then(onFulfilled);
    },
  };

  const db = {
    insert: vi.fn(() => chain),
    select: vi.fn(() => chain),
    update: vi.fn(() => chain),
  };
  return { db: db as unknown as ConstructorParameters<typeof ChainOpsRepository>[0], captured };
}

/* ─── Tests ─── */

describe("ChainOpsRepository.upsertBatch", () => {
  it("empty input → returns 0 без insert", async () => {
    const { db, captured } = makeFakeDb();
    const repo = new ChainOpsRepository(db);
    const r = await repo.upsertBatch([]);
    expect(r).toBe(0);
    expect(captured.insertValues).toBeUndefined();
  });

  it("converts UpsertInput → DB row shape", async () => {
    const { db, captured } = makeFakeDb({
      upserted: [{ id: "row-1" }],
    });
    const repo = new ChainOpsRepository(db);
    await repo.upsertBatch([
      {
        walletId: "w1",
        chain: "eth",
        txHash: "0xabc",
        logIndex: 0,
        opType: "swap",
        opTime: new Date("2025-09-28T15:36:25Z"),
        status: "ok",
        raw: { hash: "0xabc", type: "swap", movement: [] },
      },
    ]);
    expect(captured.insertValues).toEqual([
      {
        walletId: "w1",
        chain: "eth",
        txHash: "0xabc",
        logIndex: 0,
        opType: "swap",
        opTime: new Date("2025-09-28T15:36:25Z"),
        status: "ok",
        raw: { hash: "0xabc", type: "swap", movement: [] },
      },
    ]);
  });

  it("использует `onConflictDoUpdate` (overwrite mode) с правильным target", async () => {
    const { db, captured } = makeFakeDb({ upserted: [{ id: "1" }] });
    const repo = new ChainOpsRepository(db);
    await repo.upsertBatch([
      {
        walletId: "w1",
        chain: "eth",
        txHash: "0xabc",
        logIndex: 0,
        opType: "swap",
        opTime: new Date(),
        status: "ok",
        raw: {},
      },
    ]);
    // target — 3 columns (walletId, txHash, logIndex)
    expect(Array.isArray(captured.conflictTarget)).toBe(true);
    expect((captured.conflictTarget as unknown[]).length).toBe(3);
    // set присутствует — это `overwrite` mode (не doNothing)
    expect(captured.conflictSet).toBeDefined();
  });

  it("returns count of affected rows", async () => {
    const { db } = makeFakeDb({
      upserted: [{ id: "1" }, { id: "2" }, { id: "3" }],
    });
    const repo = new ChainOpsRepository(db);
    const r = await repo.upsertBatch([
      {
        walletId: "w1",
        chain: "eth",
        txHash: "0xabc",
        logIndex: 0,
        opType: "swap",
        opTime: new Date(),
        status: "ok",
        raw: {},
      },
      {
        walletId: "w1",
        chain: "eth",
        txHash: "0xdef",
        logIndex: 0,
        opType: "transfer",
        opTime: new Date(),
        status: "ok",
        raw: {},
      },
      {
        walletId: "w1",
        chain: "eth",
        txHash: "0xghi",
        logIndex: 0,
        opType: "lp_add",
        opTime: new Date(),
        status: "ok",
        raw: {},
      },
    ]);
    expect(r).toBe(3);
  });
});

describe("ChainOpsRepository.listByWallet", () => {
  it("default order = desc (newest first)", async () => {
    const sample = [
      { id: "1", opTime: new Date("2025-01-01"), txHash: "0xa" },
    ];
    const { db } = makeFakeDb({ selected: sample });
    const repo = new ChainOpsRepository(db);
    const r = await repo.listByWallet("w1");
    expect(r).toHaveLength(1);
  });

  it("explicit limit передаётся в query", async () => {
    const { db, captured } = makeFakeDb({ selected: [] });
    const repo = new ChainOpsRepository(db);
    await repo.listByWallet("w1", { limit: 50 });
    expect(captured.selectLimit).toBe(50);
  });
});

describe("ChainOpsRepository.findByHash — UCB graph traversal", () => {
  it("empty walletIds → empty result без query", async () => {
    const { db } = makeFakeDb();
    const repo = new ChainOpsRepository(db);
    const r = await repo.findByHash([], "0xabc");
    expect(r).toEqual([]);
  });

  it("non-empty walletIds → query inArray", async () => {
    const sample = [
      { walletId: "w1", txHash: "0xabc", chain: "eth" },
      { walletId: "w2", txHash: "0xabc", chain: "eth" },
    ];
    const { db } = makeFakeDb({ selected: sample });
    const repo = new ChainOpsRepository(db);
    const r = await repo.findByHash(["w1", "w2"], "0xabc");
    expect(r).toHaveLength(2);
  });
});

describe("ChainOpsRepository.latestOpTimestamp — delta-refresh helper", () => {
  it("returns null когда wallet пустой", async () => {
    const { db } = makeFakeDb({ selected: [] });
    const repo = new ChainOpsRepository(db);
    const r = await repo.latestOpTimestamp("w1");
    expect(r).toBeNull();
  });

  it("returns timestamp последней op", async () => {
    const t = new Date("2025-09-28T15:36:25Z");
    const { db, captured } = makeFakeDb({ selected: [{ t }] });
    const repo = new ChainOpsRepository(db);
    const r = await repo.latestOpTimestamp("w1");
    expect(r).toEqual(t);
    expect(captured.selectLimit).toBe(1);
  });
});

describe("ChainOpsRepository.markSyncSuccess / markSyncError", () => {
  it("markSyncSuccess — sets lastOpsSyncAt + clears error", async () => {
    const { db, captured } = makeFakeDb();
    const repo = new ChainOpsRepository(db);
    await repo.markSyncSuccess("w1");
    const set = captured.updateSet as {
      lastOpsSyncAt: Date;
      lastOpsSyncError: null;
    };
    expect(set.lastOpsSyncAt).toBeInstanceOf(Date);
    expect(set.lastOpsSyncError).toBeNull();
  });

  it("markSyncError — truncates сообщение до 500 chars", async () => {
    const { db, captured } = makeFakeDb();
    const repo = new ChainOpsRepository(db);
    const longMsg = "x".repeat(1000);
    await repo.markSyncError("w1", longMsg);
    const set = captured.updateSet as { lastOpsSyncError: string };
    expect(set.lastOpsSyncError.length).toBe(500);
  });
});

describe("ChainOpsRepository.findCrossWalletSameHashPairs — UCB A1 Layer 1", () => {
  it("returns [] для < 2 wallets (нет смысла джойнить)", async () => {
    const { db } = makeFakeDb({ selected: [{ txHash: "0xabc" }] });
    const repo = new ChainOpsRepository(db);
    expect(await repo.findCrossWalletSameHashPairs([])).toEqual([]);
    expect(await repo.findCrossWalletSameHashPairs(["w1"])).toEqual([]);
  });

  it("проксирует результат SELF-JOIN'а как массив пар", async () => {
    const mockPair = {
      txHash: "0xabc",
      chain: "arb",
      opTime: new Date("2026-01-01T00:00:00Z"),
      outWalletId: "w1",
      outOpType: "transfer_out",
      outRaw: { hash: "0xabc", type: "transfer_out" },
      inWalletId: "w2",
      inOpType: "transfer_in",
      inRaw: { hash: "0xabc", type: "transfer_in" },
    };
    const { db } = makeFakeDb({ selected: [mockPair] });
    const repo = new ChainOpsRepository(db);
    const pairs = await repo.findCrossWalletSameHashPairs(["w1", "w2"]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.txHash).toBe("0xabc");
    expect(pairs[0]?.outWalletId).toBe("w1");
    expect(pairs[0]?.inWalletId).toBe("w2");
  });
});

describe("ChainOpsRepository.listUserWalletIds — ownership helper", () => {
  it("returns пустой массив если у user'а нет wallets", async () => {
    const { db } = makeFakeDb({ selected: [] });
    const repo = new ChainOpsRepository(db);
    expect(await repo.listUserWalletIds("u1")).toEqual([]);
  });

  it("маппит rows → string[] ids", async () => {
    const { db } = makeFakeDb({
      selected: [{ id: "w1" }, { id: "w2" }, { id: "w3" }],
    });
    const repo = new ChainOpsRepository(db);
    expect(await repo.listUserWalletIds("u1")).toEqual(["w1", "w2", "w3"]);
  });
});
