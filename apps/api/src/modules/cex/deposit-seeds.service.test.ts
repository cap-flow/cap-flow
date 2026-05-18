/**
 * UCB C1: tests for DepositSeedsService.
 *
 * Service layer добавляет к repo:
 *   - Audit log on upsert / delete
 *   - Input validation (note length, hash format sanity)
 *   - Resolved bulk lookup `resolveCostBasisByHash(userId, hashes)`
 *     возвращает Map<lowercase-hash, number> для applyDeposit.
 */
import { describe, expect, it, vi } from "vitest";

import { DepositSeedsService } from "./deposit-seeds.service.js";
import type {
  DepositSeedRow,
  DepositSeedUpsertInput,
} from "./deposit-seeds.repository.js";

interface FakeRepoState {
  upserted: DepositSeedUpsertInput[];
  rows: DepositSeedRow[];
  deleted: string[];
}

function makeFakeRepo(initial: Partial<FakeRepoState> = {}) {
  const state: FakeRepoState = {
    upserted: initial.upserted ?? [],
    rows: initial.rows ?? [],
    deleted: initial.deleted ?? [],
  };
  return {
    state,
    async upsertMany(inputs: readonly DepositSeedUpsertInput[]) {
      for (const i of inputs) {
        if (!Number.isFinite(i.costBasisUsd) || i.costBasisUsd < 0) {
          throw new Error("invalid");
        }
        state.upserted.push(i);
      }
      return inputs.length;
    },
    async findByTxHashes(userId: string, hashes: readonly string[]) {
      // Real repo нормализует hashes к lowercase ДО query — fake тоже.
      const normalized = hashes.map((h) => h.toLowerCase());
      return state.rows.filter(
        (r) => r.userId === userId && normalized.includes(r.txHash),
      );
    },
    async listByUser(userId: string) {
      return state.rows.filter((r) => r.userId === userId);
    },
    async deleteByTxHash(userId: string, txHash: string) {
      const found = state.rows.find(
        (r) => r.userId === userId && r.txHash === txHash.toLowerCase(),
      );
      if (!found) return false;
      state.rows = state.rows.filter((r) => r.id !== found.id);
      state.deleted.push(txHash);
      return true;
    },
  };
}

function makeFakeAudit() {
  const calls: { action: string; payload?: unknown }[] = [];
  return {
    calls,
    log: vi.fn(async (input: { action: string; payload?: unknown }) => {
      calls.push({
        action: input.action,
        ...(input.payload !== undefined ? { payload: input.payload } : {}),
      });
    }),
  };
}

function row(args: Partial<DepositSeedRow> & {
  userId: string;
  txHash: string;
  costBasisUsd: string;
}): DepositSeedRow {
  return {
    id: args.id ?? "seed-" + args.txHash,
    userId: args.userId,
    txHash: args.txHash.toLowerCase(),
    chain: args.chain ?? "eth",
    costBasisUsd: args.costBasisUsd,
    walletId: args.walletId ?? null,
    note: args.note ?? null,
    createdAt: args.createdAt ?? new Date(1000),
    updatedAt: args.updatedAt ?? new Date(1000),
  };
}

describe("DepositSeedsService — UCB C1", () => {
  describe("upsertMany", () => {
    it("прокидывает batch в repo и пишет audit", async () => {
      const repo = makeFakeRepo();
      const audit = makeFakeAudit();
      const svc = new DepositSeedsService(repo as never, audit as never);
      const count = await svc.upsertMany("u1", [
        {
          txHash: "0xABC",
          chain: "eth",
          costBasisUsd: 1234.56,
          walletId: "w1",
          note: null,
        },
      ]);
      expect(count).toBe(1);
      expect(repo.state.upserted).toHaveLength(1);
      expect(repo.state.upserted[0]?.userId).toBe("u1");
      expect(audit.calls).toHaveLength(1);
      expect(audit.calls[0]?.action).toBe("cex.deposit_seeds.upsert");
    });

    it("пустой массив → 0, без audit log", async () => {
      const repo = makeFakeRepo();
      const audit = makeFakeAudit();
      const svc = new DepositSeedsService(repo as never, audit as never);
      const count = await svc.upsertMany("u1", []);
      expect(count).toBe(0);
      expect(audit.calls).toHaveLength(0);
    });

    it("truncates note до 500 chars", async () => {
      const repo = makeFakeRepo();
      const audit = makeFakeAudit();
      const svc = new DepositSeedsService(repo as never, audit as never);
      const longNote = "x".repeat(1000);
      await svc.upsertMany("u1", [
        {
          txHash: "0xabc",
          chain: "eth",
          costBasisUsd: 100,
          walletId: null,
          note: longNote,
        },
      ]);
      const stored = repo.state.upserted[0]?.note;
      expect(stored?.length).toBe(500);
    });

    it("отвергает negative costBasis (defensive — repo тоже валидирует)", async () => {
      const repo = makeFakeRepo();
      const audit = makeFakeAudit();
      const svc = new DepositSeedsService(repo as never, audit as never);
      await expect(
        svc.upsertMany("u1", [
          {
            txHash: "0xabc",
            chain: "eth",
            costBasisUsd: -10,
            walletId: null,
            note: null,
          },
        ]),
      ).rejects.toThrow();
    });

    it("отвергает batch > MAX_BATCH (1000)", async () => {
      const repo = makeFakeRepo();
      const audit = makeFakeAudit();
      const svc = new DepositSeedsService(repo as never, audit as never);
      const huge = Array.from({ length: 1001 }, (_, i) => ({
        txHash: `0x${i.toString(16).padStart(40, "0")}`,
        chain: "eth",
        costBasisUsd: 100,
        walletId: null,
        note: null,
      }));
      await expect(svc.upsertMany("u1", huge)).rejects.toThrow(/batch|too many/i);
    });
  });

  describe("resolveCostBasisByHash", () => {
    it("возвращает Map<lowercase-hash, number>", async () => {
      const repo = makeFakeRepo({
        rows: [
          row({ userId: "u1", txHash: "0xabc", costBasisUsd: "1500.00" }),
          row({ userId: "u1", txHash: "0xdef", costBasisUsd: "2000.00" }),
        ],
      });
      const audit = makeFakeAudit();
      const svc = new DepositSeedsService(repo as never, audit as never);
      const map = await svc.resolveCostBasisByHash("u1", ["0xABC", "0xdef", "0xnomatch"]);
      expect(map.size).toBe(2);
      expect(map.get("0xabc")).toBeCloseTo(1500, 2);
      expect(map.get("0xdef")).toBeCloseTo(2000, 2);
      expect(map.has("0xnomatch")).toBe(false);
    });

    it("empty batch → empty map", async () => {
      const repo = makeFakeRepo();
      const audit = makeFakeAudit();
      const svc = new DepositSeedsService(repo as never, audit as never);
      const map = await svc.resolveCostBasisByHash("u1", []);
      expect(map.size).toBe(0);
    });

    it("ignores rows другого юзера (defensive — repo тоже filter'ит)", async () => {
      const repo = makeFakeRepo({
        rows: [
          row({ userId: "u1", txHash: "0xabc", costBasisUsd: "100" }),
        ],
      });
      const audit = makeFakeAudit();
      const svc = new DepositSeedsService(repo as never, audit as never);
      const map = await svc.resolveCostBasisByHash("u2", ["0xabc"]);
      expect(map.size).toBe(0);
    });
  });

  describe("listAll", () => {
    it("возвращает все seeds юзера со normalized USD numbers", async () => {
      const repo = makeFakeRepo({
        rows: [row({ userId: "u1", txHash: "0xabc", costBasisUsd: "1234.56" })],
      });
      const audit = makeFakeAudit();
      const svc = new DepositSeedsService(repo as never, audit as never);
      const list = await svc.listAll("u1");
      expect(list).toHaveLength(1);
      expect(list[0]?.costBasisUsd).toBeCloseTo(1234.56, 2);
      expect(list[0]?.txHash).toBe("0xabc");
    });
  });

  describe("delete", () => {
    it("delete + audit, если row существует", async () => {
      const repo = makeFakeRepo({
        rows: [row({ userId: "u1", txHash: "0xabc", costBasisUsd: "100" })],
      });
      const audit = makeFakeAudit();
      const svc = new DepositSeedsService(repo as never, audit as never);
      const ok = await svc.delete("u1", "0xABC");
      expect(ok).toBe(true);
      expect(audit.calls).toHaveLength(1);
      expect(audit.calls[0]?.action).toBe("cex.deposit_seeds.delete");
    });

    it("delete несуществующего → false, без audit", async () => {
      const repo = makeFakeRepo();
      const audit = makeFakeAudit();
      const svc = new DepositSeedsService(repo as never, audit as never);
      const ok = await svc.delete("u1", "0xunknown");
      expect(ok).toBe(false);
      expect(audit.calls).toHaveLength(0);
    });
  });
});
