/**
 * B5 — shadow-diff route core (framework-free), with a stubbed repo.
 */
import { describe, expect, it, vi } from "vitest";

import { runShadowDiff, type ShadowDiffDeps } from "./ucb-shadow-diff.handler.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pos = (id: string, startUsd: number) =>
  ({
    chain: "arb",
    protocol: { id: "arb_fluid" },
    lpTokenId: id,
    matchedV3TokenId: null,
    openHash: null,
    startUsd,
    supplyTokens: [{ symbol: "ETH" }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

describe("runShadowDiff (route core)", () => {
  it("no server shadow yet → status no_shadow, no update", async () => {
    const updateDiffSummary = vi.fn(async () => {});
    const deps: ShadowDiffDeps = {
      shadowRepo: {
        findLatestForAccount: async () => null,
        updateDiffSummary,
      },
    };
    const r = await runShadowDiff(deps, "acc", [pos("0xa", 100)]);
    expect(r).toEqual({ status: "no_shadow", summary: null });
    expect(updateDiffSummary).not.toHaveBeenCalled();
  });

  it("shadow exists → diffs, persists summary onto that row, returns compared", async () => {
    const computedAt = new Date("2026-06-01T00:00:00.000Z");
    const updateDiffSummary = vi.fn(async (_id: string, _s: unknown) => {});
    const deps: ShadowDiffDeps = {
      shadowRepo: {
        findLatestForAccount: async () => ({
          id: "shadow-9",
          accountId: "acc",
          computedAt,
          trigger: "refresh",
          lotMethodology: "FIFO",
          positionCount: 1,
          positions: [pos("0xa", 100)],
          engineVersion: "ucb@test",
          diffSummary: null,
          error: null,
        }),
        updateDiffSummary,
      },
    };
    // client says 103 vs server 100 → |Δ|=3 > $1 → 1 divergent.
    const r = await runShadowDiff(deps, "acc", [pos("0xa", 103)]);
    expect(r.status).toBe("compared");
    if (r.status !== "compared") throw new Error("unreachable");
    expect(r.shadowId).toBe("shadow-9");
    expect(r.computedAt).toBe(computedAt);
    expect(r.summary.divergentCount).toBe(1);
    // persisted onto the same shadow row
    expect(updateDiffSummary).toHaveBeenCalledOnce();
    expect(updateDiffSummary.mock.calls[0]![0]).toBe("shadow-9");
    expect(updateDiffSummary.mock.calls[0]![1]).toBe(r.summary);
  });

  it("matching positions → zero divergence (distinct from no_shadow)", async () => {
    const deps: ShadowDiffDeps = {
      shadowRepo: {
        findLatestForAccount: async () => ({
          id: "s1",
          accountId: "acc",
          computedAt: new Date(),
          trigger: "refresh",
          lotMethodology: "FIFO",
          positionCount: 1,
          positions: [pos("0xa", 100)],
          engineVersion: "x",
          diffSummary: null,
          error: null,
        }),
        updateDiffSummary: async () => {},
      },
    };
    const r = await runShadowDiff(deps, "acc", [pos("0xa", 100.5)]);
    if (r.status !== "compared") throw new Error("expected compared");
    expect(r.summary.divergentCount).toBe(0);
    expect(r.summary.matchedCount).toBe(1);
  });
});
