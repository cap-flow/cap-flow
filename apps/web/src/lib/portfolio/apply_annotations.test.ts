/**
 * UCB A4 + D8: tests for applyAnnotationsToOps.
 */
import { describe, expect, it } from "vitest";

import { applyAnnotationsToOps } from "./apply_annotations";
import type { ClassifiedOp } from "./types";
import type { ResolvedAnnotation } from "@/features/chain-ops/api";

function op(args: {
  hash: string;
  type: string;
  time?: number;
  chain?: string;
}): ClassifiedOp {
  return {
    hash: args.hash,
    type: args.type as never,
    time: args.time ?? 1000,
    chain: args.chain ?? "eth",
    status: "success",
    movement: [],
    fnName: "",
    cateId: "",
    counter: "",
    counterName: "",
    project: null,
    protocol: null,
    fees: { gasUsd: 0, otherUsd: 0 },
    notes: [],
    seq: 0,
    isInternal: false,
    counterAddresses: [],
    netUsd: 0,
    gasUsd: 0,
  } as ClassifiedOp;
}

function ann(args: {
  hash: string;
  walletId: string;
  manualOpType?: string;
  excluded?: boolean;
}): ResolvedAnnotation {
  return {
    id: "id-" + args.hash,
    chainOpId: "cop-" + args.hash,
    userId: "u1",
    isInternalTransfer: null,
    manualCostBasisUsd: null,
    manualOpType: args.manualOpType ?? null,
    note: null,
    excluded: args.excluded ?? false,
    createdAt: new Date(1000).toISOString(),
    updatedAt: new Date(1000).toISOString(),
    txHash: args.hash,
    walletId: args.walletId,
    logIndex: 0,
  };
}

describe("applyAnnotationsToOps", () => {
  it("пустые annotations → ops as-is", () => {
    const ops = [op({ hash: "0xaaa", type: "swap" })];
    expect(applyAnnotationsToOps(ops, "w1", new Map())).toEqual(ops);
  });

  it("A4.1: manualOpType override переписывает op.type", () => {
    const ops = [op({ hash: "0xaaa", type: "swap" })];
    const map = new Map([
      [
        "w1|0xaaa|0",
        ann({ hash: "0xaaa", walletId: "w1", manualOpType: "transfer_in" }),
      ],
    ]);
    const result = applyAnnotationsToOps(ops, "w1", map);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("transfer_in");
  });

  it("manualOpType not in whitelist → ignored", () => {
    const ops = [op({ hash: "0xaaa", type: "swap" })];
    const map = new Map([
      [
        "w1|0xaaa|0",
        ann({ hash: "0xaaa", walletId: "w1", manualOpType: "malicious_type" }),
      ],
    ]);
    const result = applyAnnotationsToOps(ops, "w1", map);
    expect(result[0]!.type).toBe("swap"); // unchanged
  });

  // ─── UCB D8 ────────────────────────────────────────────────────────
  it("D8: excluded=true → op полностью убран из output", () => {
    const ops = [
      op({ hash: "0xaaa", type: "swap" }),
      op({ hash: "0xbbb", type: "transfer_in" }),
      op({ hash: "0xccc", type: "swap" }),
    ];
    const map = new Map([
      ["w1|0xbbb|0", ann({ hash: "0xbbb", walletId: "w1", excluded: true })],
    ]);
    const result = applyAnnotationsToOps(ops, "w1", map);
    expect(result).toHaveLength(2);
    expect(result.map((o) => o.hash)).toEqual(["0xaaa", "0xccc"]);
  });

  it("D8: excluded=false → op остаётся (no-op)", () => {
    const ops = [op({ hash: "0xaaa", type: "swap" })];
    const map = new Map([
      ["w1|0xaaa|0", ann({ hash: "0xaaa", walletId: "w1", excluded: false })],
    ]);
    const result = applyAnnotationsToOps(ops, "w1", map);
    expect(result).toHaveLength(1);
  });

  it("D8: excluded overrides ВСЕ остальные annotations (manualOpType ignored)", () => {
    const ops = [op({ hash: "0xaaa", type: "swap" })];
    const map = new Map([
      [
        "w1|0xaaa|0",
        ann({
          hash: "0xaaa",
          walletId: "w1",
          excluded: true,
          manualOpType: "bridge_in",
        }),
      ],
    ]);
    const result = applyAnnotationsToOps(ops, "w1", map);
    // Excluded wins — op полностью убран, manualOpType неважен.
    expect(result).toHaveLength(0);
  });

  it("D8: множественные excluded → все убраны", () => {
    const ops = [
      op({ hash: "0xa", type: "swap" }),
      op({ hash: "0xb", type: "swap" }),
      op({ hash: "0xc", type: "transfer_in" }),
    ];
    const map = new Map([
      ["w1|0xa|0", ann({ hash: "0xa", walletId: "w1", excluded: true })],
      ["w1|0xb|0", ann({ hash: "0xb", walletId: "w1", excluded: true })],
    ]);
    const result = applyAnnotationsToOps(ops, "w1", map);
    expect(result).toHaveLength(1);
    expect(result[0]!.hash).toBe("0xc");
  });
});
