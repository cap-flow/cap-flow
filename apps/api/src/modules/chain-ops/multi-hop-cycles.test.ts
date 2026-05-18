/**
 * UCB A5.2: tests for multi-hop cycle detector.
 *
 * 2-hop covered в A5. Multi-hop = A→B→C→A, A→B→C→D→A, etc.
 *
 * Algorithm: build adjacency graph from MatchedCrossChainPair[] keyed by
 * (outWallet → inWallet). DFS from each starting pair, walking forward
 * по chronological order, detect when we return to origin within window.
 */
import { describe, expect, it } from "vitest";

import { detectMultiHopCycles } from "./multi-hop-cycles.js";
import type { MatchedCrossChainPair } from "./internal-transfer-matcher.js";

const t = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);

function pair(args: {
  outWalletId: string;
  inWalletId: string;
  symbol?: string;
  outAmount?: number;
  inAmount?: number;
  feeUsd?: number;
  outTimeSec: number;
  inTimeSec: number;
  outTxHash?: string;
  inTxHash?: string;
}): MatchedCrossChainPair {
  return {
    outTxHash: args.outTxHash ?? `out_${args.outWalletId}_${args.outTimeSec}`,
    inTxHash: args.inTxHash ?? `in_${args.inWalletId}_${args.inTimeSec}`,
    outChain: "eth",
    inChain: "arb",
    outWalletId: args.outWalletId,
    inWalletId: args.inWalletId,
    symbol: args.symbol ?? "ETH",
    outAmount: args.outAmount ?? 1,
    inAmount: args.inAmount ?? 0.99,
    feeUsd: args.feeUsd ?? 10,
    outRaw: {},
    inRaw: {},
    outOpTimeSec: args.outTimeSec,
    inOpTimeSec: args.inTimeSec,
  };
}

describe("detectMultiHopCycles — UCB A5.2", () => {
  it("empty → []", () => {
    expect(detectMultiHopCycles([])).toEqual([]);
  });

  it("single 2-hop A→B→A is detected as 2-hop cycle", () => {
    const pairs = [
      pair({
        outWalletId: "w1",
        inWalletId: "w2",
        outTimeSec: t("2026-01-01T00:00:00Z"),
        inTimeSec: t("2026-01-01T00:10:00Z"),
      }),
      pair({
        outWalletId: "w2",
        inWalletId: "w1",
        outTimeSec: t("2026-01-02T00:00:00Z"),
        inTimeSec: t("2026-01-02T00:10:00Z"),
      }),
    ];
    const cycles = detectMultiHopCycles(pairs);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.legs).toHaveLength(2);
    expect(cycles[0]?.originWalletId).toBe("w1");
    expect(cycles[0]?.walletPath).toEqual(["w1", "w2", "w1"]);
  });

  it("3-hop A→B→C→A detected", () => {
    const pairs = [
      pair({
        outWalletId: "w1",
        inWalletId: "w2",
        outTimeSec: t("2026-01-01T00:00:00Z"),
        inTimeSec: t("2026-01-01T00:10:00Z"),
      }),
      pair({
        outWalletId: "w2",
        inWalletId: "w3",
        outTimeSec: t("2026-01-02T00:00:00Z"),
        inTimeSec: t("2026-01-02T00:10:00Z"),
      }),
      pair({
        outWalletId: "w3",
        inWalletId: "w1",
        outTimeSec: t("2026-01-03T00:00:00Z"),
        inTimeSec: t("2026-01-03T00:10:00Z"),
      }),
    ];
    const cycles = detectMultiHopCycles(pairs);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.legs).toHaveLength(3);
    expect(cycles[0]?.walletPath).toEqual(["w1", "w2", "w3", "w1"]);
  });

  it("4-hop A→B→C→D→A detected", () => {
    const pairs = [
      pair({
        outWalletId: "w1",
        inWalletId: "w2",
        outTimeSec: t("2026-01-01T00:00:00Z"),
        inTimeSec: t("2026-01-01T00:10:00Z"),
      }),
      pair({
        outWalletId: "w2",
        inWalletId: "w3",
        outTimeSec: t("2026-01-02T00:00:00Z"),
        inTimeSec: t("2026-01-02T00:10:00Z"),
      }),
      pair({
        outWalletId: "w3",
        inWalletId: "w4",
        outTimeSec: t("2026-01-03T00:00:00Z"),
        inTimeSec: t("2026-01-03T00:10:00Z"),
      }),
      pair({
        outWalletId: "w4",
        inWalletId: "w1",
        outTimeSec: t("2026-01-04T00:00:00Z"),
        inTimeSec: t("2026-01-04T00:10:00Z"),
      }),
    ];
    const cycles = detectMultiHopCycles(pairs);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.legs).toHaveLength(4);
    expect(cycles[0]?.walletPath).toEqual(["w1", "w2", "w3", "w4", "w1"]);
  });

  it("walks ONLY chronologically (later out > previous in)", () => {
    // Это linear: w1→w2 at day 1, w2→w3 at day 5, w3→w1 at day 10.
    // НО среди pairs есть отдельный w1→w3 at day 0 — он не должен
    // считаться частью этой петли (другой starting point).
    const pairs = [
      pair({
        outWalletId: "w1",
        inWalletId: "w2",
        outTimeSec: t("2026-01-01T00:00:00Z"),
        inTimeSec: t("2026-01-01T00:10:00Z"),
      }),
      pair({
        outWalletId: "w2",
        inWalletId: "w3",
        outTimeSec: t("2026-01-05T00:00:00Z"),
        inTimeSec: t("2026-01-05T00:10:00Z"),
      }),
      pair({
        outWalletId: "w3",
        inWalletId: "w1",
        outTimeSec: t("2026-01-10T00:00:00Z"),
        inTimeSec: t("2026-01-10T00:10:00Z"),
      }),
    ];
    const cycles = detectMultiHopCycles(pairs);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.legs).toHaveLength(3);
  });

  it("disjoint linear path (нет return to origin) → []", () => {
    const pairs = [
      pair({
        outWalletId: "w1",
        inWalletId: "w2",
        outTimeSec: t("2026-01-01T00:00:00Z"),
        inTimeSec: t("2026-01-01T00:10:00Z"),
      }),
      pair({
        outWalletId: "w2",
        inWalletId: "w3",
        outTimeSec: t("2026-01-02T00:00:00Z"),
        inTimeSec: t("2026-01-02T00:10:00Z"),
      }),
    ];
    expect(detectMultiHopCycles(pairs)).toEqual([]);
  });

  it("cycle longer than 14 days window → skipped (too stale)", () => {
    const pairs = [
      pair({
        outWalletId: "w1",
        inWalletId: "w2",
        outTimeSec: t("2026-01-01T00:00:00Z"),
        inTimeSec: t("2026-01-01T00:10:00Z"),
      }),
      pair({
        outWalletId: "w2",
        inWalletId: "w3",
        outTimeSec: t("2026-01-10T00:00:00Z"),
        inTimeSec: t("2026-01-10T00:10:00Z"),
      }),
      pair({
        outWalletId: "w3",
        inWalletId: "w1",
        outTimeSec: t("2026-01-20T00:00:00Z"), // total >14d
        inTimeSec: t("2026-01-20T00:10:00Z"),
      }),
    ];
    expect(detectMultiHopCycles(pairs)).toEqual([]);
  });

  it("total fee USD = sum of all legs", () => {
    const pairs = [
      pair({
        outWalletId: "w1",
        inWalletId: "w2",
        feeUsd: 5,
        outTimeSec: t("2026-01-01T00:00:00Z"),
        inTimeSec: t("2026-01-01T00:10:00Z"),
      }),
      pair({
        outWalletId: "w2",
        inWalletId: "w3",
        feeUsd: 10,
        outTimeSec: t("2026-01-02T00:00:00Z"),
        inTimeSec: t("2026-01-02T00:10:00Z"),
      }),
      pair({
        outWalletId: "w3",
        inWalletId: "w1",
        feeUsd: 7,
        outTimeSec: t("2026-01-03T00:00:00Z"),
        inTimeSec: t("2026-01-03T00:10:00Z"),
      }),
    ];
    const cycles = detectMultiHopCycles(pairs);
    expect(cycles[0]?.totalFeeUsd).toBeCloseTo(22, 2);
  });

  it("idempotent: повторный вызов даёт identical output", () => {
    const pairs = [
      pair({
        outWalletId: "w1",
        inWalletId: "w2",
        outTimeSec: t("2026-01-01T00:00:00Z"),
        inTimeSec: t("2026-01-01T00:10:00Z"),
      }),
      pair({
        outWalletId: "w2",
        inWalletId: "w1",
        outTimeSec: t("2026-01-02T00:00:00Z"),
        inTimeSec: t("2026-01-02T00:10:00Z"),
      }),
    ];
    expect(detectMultiHopCycles(pairs)).toEqual(detectMultiHopCycles(pairs));
  });
});
