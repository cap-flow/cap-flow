import { describe, expect, it, vi } from "vitest";

import type { ClassifiedOp } from "@cap-flow/ucb/types";

import {
  OpPricingFillService,
  type OpPricingFillable,
  type ComputeOpsLoader,
  type AccountLister,
} from "./op-pricing-fill.service.js";
import type { PriceNeed } from "./op-pricing.service.js";

const op = (): ClassifiedOp => ({}) as unknown as ClassifiedOp;
const need = (coin: string): PriceNeed => ({
  coin,
  hourBucket: 1_700_000_000,
  timestamp: 1_700_000_001,
  chain: "arb",
  tokenId: null,
});

function accounts(ids: string[]): AccountLister {
  return { findAllActive: async () => ids.map((id) => ({ id })) };
}

describe("OpPricingFillService.run (B1 cache-fill sweep)", () => {
  it("sweeps accounts, collects needs, fills, aggregates counts", async () => {
    const opsRepo: ComputeOpsLoader = {
      loadComputeWalletsForAccount: async (id) =>
        id === "a"
          ? [{ ops: [op(), op()] }, { ops: [op()] }] // 3 ops
          : [{ ops: [op()] }], // 1 op
    };
    const fillMissing = vi.fn(async (m: readonly PriceNeed[]) => ({
      written: m.length,
    }));
    const opPricing: OpPricingFillable = {
      priceMapForOps: async (ops) => ({
        missing: ops.length >= 2 ? [need("c1"), need("c2")] : [need("c3")],
      }),
      fillMissing,
    };
    const svc = new OpPricingFillService({
      accounts: accounts(["a", "b"]),
      opsRepo,
      opPricing,
    });

    const r = await svc.run();
    expect(r.accounts).toBe(2);
    expect(r.accountsFailed).toBe(0);
    expect(r.opsSeen).toBe(4); // 3 + 1
    expect(r.needed).toBe(3); // 2 (a) + 1 (b)
    expect(r.written).toBe(3);
    expect(fillMissing).toHaveBeenCalledTimes(2);
  });

  it("fail-soft: a throwing account is counted and skipped, others continue", async () => {
    const opsRepo: ComputeOpsLoader = {
      loadComputeWalletsForAccount: async (id) => {
        if (id === "bad") throw new Error("db down");
        return [{ ops: [op()] }];
      },
    };
    const opPricing: OpPricingFillable = {
      priceMapForOps: async () => ({ missing: [need("c1")] }),
      fillMissing: async (m) => ({ written: m.length }),
    };
    const warn = vi.fn();
    const svc = new OpPricingFillService({
      accounts: accounts(["good1", "bad", "good2"]),
      opsRepo,
      opPricing,
      logger: { info: vi.fn(), warn },
    });

    const r = await svc.run();
    expect(r.accounts).toBe(3);
    expect(r.accountsFailed).toBe(1);
    expect(r.written).toBe(2); // good1 + good2
    expect(warn).toHaveBeenCalledOnce();
  });

  it("skips accounts with zero ops (no fillMissing call)", async () => {
    const fillMissing = vi.fn(async () => ({ written: 0 }));
    const opPricing: OpPricingFillable = {
      priceMapForOps: async () => ({ missing: [need("c1")] }),
      fillMissing,
    };
    const svc = new OpPricingFillService({
      accounts: accounts(["empty"]),
      opsRepo: { loadComputeWalletsForAccount: async () => [{ ops: [] }] },
      opPricing,
    });

    const r = await svc.run();
    expect(r.opsSeen).toBe(0);
    expect(r.needed).toBe(0);
    expect(fillMissing).not.toHaveBeenCalled();
  });

  it("respects an already-aborted signal (processes nothing)", async () => {
    const load = vi.fn(async () => [{ ops: [op()] }]);
    const svc = new OpPricingFillService({
      accounts: accounts(["a", "b"]),
      opsRepo: { loadComputeWalletsForAccount: load },
      opPricing: {
        priceMapForOps: async () => ({ missing: [] }),
        fillMissing: async () => ({ written: 0 }),
      },
    });
    const ac = new AbortController();
    ac.abort();
    const r = await svc.run(ac.signal);
    expect(load).not.toHaveBeenCalled();
    expect(r.opsSeen).toBe(0);
  });

  it("no missing keys → no fill, zero written", async () => {
    const fillMissing = vi.fn(async () => ({ written: 0 }));
    const svc = new OpPricingFillService({
      accounts: accounts(["a"]),
      opsRepo: { loadComputeWalletsForAccount: async () => [{ ops: [op()] }] },
      opPricing: { priceMapForOps: async () => ({ missing: [] }), fillMissing },
    });
    const r = await svc.run();
    expect(r.needed).toBe(0);
    expect(fillMissing).not.toHaveBeenCalled();
  });
});
