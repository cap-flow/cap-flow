/**
 * B5 shadow orchestration — flag gate + fail-soft, with stubbed deps.
 */
import { describe, expect, it, vi } from "vitest";

import {
  UCB_SERVER_SHADOW_FLAG,
  UcbShadowService,
  type UcbShadowServiceDeps,
} from "./ucb-shadow.service.js";
import type { UcbShadowWriteInput } from "./ucb-shadow.repository.js";

const stubPricing = { priceMapForOps: async () => ({ histPrices: new Map(), missing: [] }) };

function makeDeps(over: Partial<UcbShadowServiceDeps> = {}): {
  deps: UcbShadowServiceDeps;
  insertResult: ReturnType<typeof vi.fn>;
  loadOps: ReturnType<typeof vi.fn>;
} {
  const insertResult = vi.fn(async (_input: UcbShadowWriteInput) => ({ id: "shadow-1" }));
  const loadOps = vi.fn(async () => [
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { wallet: { id: "w1", name: "w", address: "0x1", chain: "evm", createdAt: 0 }, ops: [] } as any,
  ]);
  const deps: UcbShadowServiceDeps = {
    opsRepo: { loadComputeWalletsForAccount: loadOps },
    shadowRepo: { insertResult },
    opPricingService: stubPricing,
    flags: { enabled: async () => true },
    engineVersion: "ucb@test",
    ...over,
  };
  return { deps, insertResult, loadOps };
}

describe("UcbShadowService.runForAccount", () => {
  it("flag OFF → skipped, nothing loaded or written", async () => {
    const { deps, insertResult, loadOps } = makeDeps({
      flags: { enabled: async () => false },
    });
    const r = await new UcbShadowService(deps).runForAccount("acc", {
      trigger: "refresh",
    });
    expect(r).toEqual({ skipped: true });
    expect(loadOps).not.toHaveBeenCalled();
    expect(insertResult).not.toHaveBeenCalled();
  });

  it("flag uses the canonical key + accountId context", async () => {
    const enabled = vi.fn(async () => false);
    const { deps } = makeDeps({ flags: { enabled } });
    await new UcbShadowService(deps).runForAccount("acc-7", { trigger: "refresh" });
    expect(enabled).toHaveBeenCalledWith(UCB_SERVER_SHADOW_FLAG, {
      accountId: "acc-7",
    });
  });

  it("flag ON → computes + stores, returns id + positionCount", async () => {
    const { deps, insertResult } = makeDeps();
    const r = await new UcbShadowService(deps).runForAccount("acc", {
      trigger: "manual",
    });
    expect(r.skipped).toBe(false);
    expect(r.id).toBe("shadow-1");
    expect(typeof r.positionCount).toBe("number");
    expect(insertResult).toHaveBeenCalledOnce();
    const arg = insertResult.mock.calls[0]![0];
    expect(arg).toMatchObject({ accountId: "acc", trigger: "manual", engineVersion: "ucb@test" });
  });

  it("fail-soft: loader throws → writes an error row, returns error, does NOT throw", async () => {
    const insertResult = vi.fn(async (_input: UcbShadowWriteInput) => ({ id: "err-row" }));
    const { deps } = makeDeps({
      opsRepo: {
        loadComputeWalletsForAccount: async () => {
          throw new Error("db down");
        },
      },
      shadowRepo: { insertResult },
    });
    const r = await new UcbShadowService(deps).runForAccount("acc", {
      trigger: "refresh",
    });
    expect(r.error).toBe("db down");
    expect(r.skipped).toBe(false);
    // error row: positions [] + error set
    expect(insertResult).toHaveBeenCalledOnce();
    const arg = insertResult.mock.calls[0]![0];
    expect(arg.positions).toEqual([]);
    expect(arg.error).toBe("db down");
  });

  it("fail-soft swallows a failing error-row write (never throws into refresh)", async () => {
    const { deps } = makeDeps({
      opsRepo: {
        loadComputeWalletsForAccount: async () => {
          throw new Error("compute boom");
        },
      },
      shadowRepo: {
        insertResult: async () => {
          throw new Error("also db down");
        },
      },
    });
    const r = await new UcbShadowService(deps).runForAccount("acc", {
      trigger: "refresh",
    });
    expect(r.error).toBe("compute boom");
  });

  it("methodologyResolver wins over the fixed lotMethodology", async () => {
    const forAccount = vi.fn(async () => "LIFO" as const);
    const { deps, insertResult } = makeDeps({
      lotMethodology: "WAC",
      methodologyResolver: { forAccount },
    });
    await new UcbShadowService(deps).runForAccount("acc-9", { trigger: "refresh" });
    expect(forAccount).toHaveBeenCalledWith("acc-9");
    expect(insertResult).toHaveBeenCalledWith(
      expect.objectContaining({ lotMethodology: "LIFO" }),
    );
  });

  it("no resolver → uses the fixed lotMethodology", async () => {
    const { deps, insertResult } = makeDeps({ lotMethodology: "WAC" });
    await new UcbShadowService(deps).runForAccount("acc", { trigger: "refresh" });
    expect(insertResult).toHaveBeenCalledWith(
      expect.objectContaining({ lotMethodology: "WAC" }),
    );
  });
});
