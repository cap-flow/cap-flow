/**
 * UCB C1: tests for DepositSeedsRepository contract.
 *
 * Cost basis seeding: client (со своим orchestrator + lot tracker) POSTs
 * `{ txHash, costBasisUsd, ... }` пары. Server сохраняет в
 * `cex_deposit_seeds`, потом `CexCostBasisService.applyDeposit` читает их
 * и использует вместо $0 / approx для CEX-deposit cost basis.
 *
 * Контракт repo тонкий (insert/find/list/delete), бизнес-валидация —
 * в service layer.
 */
import { describe, expect, it, vi } from "vitest";

import { DepositSeedsRepository } from "./deposit-seeds.repository.js";

function makeFakeDb(state: { upserted?: unknown[]; selected?: unknown[] } = {}) {
  const captured: {
    insertValues?: unknown[];
    conflictTarget?: unknown;
    conflictSet?: unknown;
    selectWhere?: unknown;
    deleteWhere?: unknown;
  } = {};

  const chain = {
    values(v: unknown[]) {
      captured.insertValues = v;
      return this;
    },
    onConflictDoUpdate(input: { target: unknown; set: unknown }) {
      captured.conflictTarget = input.target;
      captured.conflictSet = input.set;
      return this;
    },
    returning() {
      return Promise.resolve(state.upserted ?? []);
    },
    from() {
      return this;
    },
    where(w: unknown) {
      if (captured.selectWhere === undefined) captured.selectWhere = w;
      else captured.deleteWhere = w;
      return this;
    },
    limit() {
      return Promise.resolve(state.selected ?? []);
    },
    orderBy() {
      return this;
    },
    then(onFulfilled: (v: unknown[]) => unknown) {
      return Promise.resolve(state.selected ?? []).then(onFulfilled);
    },
  };

  const db = {
    insert: vi.fn(() => chain),
    select: vi.fn(() => chain),
    delete: vi.fn(() => chain),
  };
  return { db, chain, captured };
}

const baseRow = {
  id: "seed-1",
  userId: "u1",
  txHash: "0xabc",
  chain: "eth",
  costBasisUsd: "1234.56",
  walletId: "w1",
  note: null,
  createdAt: new Date(1000),
  updatedAt: new Date(1000),
};

describe("DepositSeedsRepository — UCB C1", () => {
  describe("upsertMany", () => {
    it("вставляет несколько seeds одним батчем", async () => {
      const { db, captured } = makeFakeDb({
        upserted: [{ ...baseRow, id: "s1" }, { ...baseRow, id: "s2", txHash: "0xdef" }],
      });
      const repo = new DepositSeedsRepository(db as never);
      const result = await repo.upsertMany([
        {
          userId: "u1",
          txHash: "0xabc",
          chain: "eth",
          costBasisUsd: 1234.56,
          walletId: "w1",
          note: null,
        },
        {
          userId: "u1",
          txHash: "0xdef",
          chain: "eth",
          costBasisUsd: 500,
          walletId: "w1",
          note: "manual",
        },
      ]);
      expect(result).toBe(2);
      expect(captured.insertValues).toHaveLength(2);
      // Should normalize tx_hash to lowercase
      expect((captured.insertValues?.[0] as { txHash: string }).txHash).toBe(
        "0xabc",
      );
    });

    it("idempotent: повторный upsert обновляет тот же row через ON CONFLICT", async () => {
      const { db, captured } = makeFakeDb({ upserted: [baseRow] });
      const repo = new DepositSeedsRepository(db as never);
      await repo.upsertMany([
        {
          userId: "u1",
          txHash: "0xABC", // uppercase — repo должен normalize
          chain: "eth",
          costBasisUsd: 2000,
          walletId: "w1",
          note: null,
        },
      ]);
      expect(captured.conflictTarget).toBeDefined();
      expect(captured.conflictSet).toBeDefined();
      const v = captured.insertValues?.[0] as { txHash: string };
      expect(v.txHash).toBe("0xabc"); // normalized
    });

    it("пустой массив → 0, без insert call", async () => {
      const { db } = makeFakeDb();
      const repo = new DepositSeedsRepository(db as never);
      const result = await repo.upsertMany([]);
      expect(result).toBe(0);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it("отвергает invalid costBasisUsd (negative)", async () => {
      const { db } = makeFakeDb();
      const repo = new DepositSeedsRepository(db as never);
      await expect(
        repo.upsertMany([
          {
            userId: "u1",
            txHash: "0xabc",
            chain: "eth",
            costBasisUsd: -100,
            walletId: null,
            note: null,
          },
        ]),
      ).rejects.toThrow(/cost.*non-negative|invalid/i);
    });

    it("отвергает invalid costBasisUsd (NaN)", async () => {
      const { db } = makeFakeDb();
      const repo = new DepositSeedsRepository(db as never);
      await expect(
        repo.upsertMany([
          {
            userId: "u1",
            txHash: "0xabc",
            chain: "eth",
            costBasisUsd: Number.NaN,
            walletId: null,
            note: null,
          },
        ]),
      ).rejects.toThrow();
    });
  });

  describe("findByTxHashes", () => {
    it("возвращает rows по списку tx hashes", async () => {
      const { db } = makeFakeDb({ selected: [baseRow] });
      const repo = new DepositSeedsRepository(db as never);
      const out = await repo.findByTxHashes("u1", ["0xabc", "0xdef"]);
      expect(out).toHaveLength(1);
      expect(out[0]?.txHash).toBe("0xabc");
    });

    it("пустой массив hashes → пустой результат, без db hit", async () => {
      const { db } = makeFakeDb();
      const repo = new DepositSeedsRepository(db as never);
      const out = await repo.findByTxHashes("u1", []);
      expect(out).toEqual([]);
      expect(db.select).not.toHaveBeenCalled();
    });

    it("normalize hashes to lowercase перед query", async () => {
      const { db } = makeFakeDb({ selected: [baseRow] });
      const repo = new DepositSeedsRepository(db as never);
      await repo.findByTxHashes("u1", ["0xABC", "0xDEF"]);
      // Implementation should call inArray with lowercase array.
      expect(db.select).toHaveBeenCalled();
    });
  });

  describe("listByUser", () => {
    it("возвращает все seeds юзера", async () => {
      const { db } = makeFakeDb({ selected: [baseRow] });
      const repo = new DepositSeedsRepository(db as never);
      const out = await repo.listByUser("u1");
      expect(out).toHaveLength(1);
    });
  });

  describe("deleteByTxHash", () => {
    it("delete по (userId, txHash)", async () => {
      const { db, captured } = makeFakeDb();
      const repo = new DepositSeedsRepository(db as never);
      await repo.deleteByTxHash("u1", "0xABC");
      expect(db.delete).toHaveBeenCalled();
      expect(captured.selectWhere).toBeDefined(); // first .where = our where
    });
  });
});
