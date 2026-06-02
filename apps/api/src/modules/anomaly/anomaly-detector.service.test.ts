/**
 * Epic C — detector scanAccount: load canonical + golden → checks → persist.
 */
import { describe, expect, it, vi } from "vitest";

import {
  AnomalyDetectorService,
  type AnomalyDetectorDeps,
  type RawGoldenCase,
} from "./anomaly-detector.service.js";

const canonicalPos = {
  id: "POS-1",
  walletId: "w1",
  chain: "op",
  protocol: { id: "op_velodrome" },
  lpTokenId: "0xgauge",
  matchedV3TokenId: null,
  openHash: null,
  startUsd: 20.4, // drifts from golden $237.80
  currentUsd: 112,
  netPnlUsd: 0,
};

const goldenRow: RawGoldenCase = {
  id: "g1",
  walletId: "w1",
  chain: "op",
  protocolId: "op_velodrome",
  marketKey: "0xgauge",
  openHash: null,
  label: "POS-011",
  kind: "golden",
  status: "active",
  expectedStartUsd: "237.80",
  toleranceAbsUsd: "1",
  tolerancePct: "0.02",
};

function makeDeps(over: Partial<AnomalyDetectorDeps> = {}): {
  deps: AnomalyDetectorDeps;
  upsertMany: ReturnType<typeof vi.fn>;
  autoResolveStale: ReturnType<typeof vi.fn>;
} {
  const upsertMany = vi.fn(async () => {});
  const autoResolveStale = vi.fn(async () => 0);
  const deps: AnomalyDetectorDeps = {
    shadowRepo: { findLatestForAccount: async () => ({ positions: [canonicalPos] }) },
    goldenRepo: { listGolden: async () => [goldenRow] },
    flagsRepo: { upsertMany, autoResolveStale },
    walletIdsForAccount: async () => ["w1"],
    detectorVersion: "detector@test",
    ...over,
  };
  return { deps, upsertMany, autoResolveStale };
}

describe("AnomalyDetectorService.scanAccount", () => {
  it("golden drift → upserts a golden_case_drift error + reports counts", async () => {
    const { deps, upsertMany, autoResolveStale } = makeDeps();
    const r = await new AnomalyDetectorService(deps).scanAccount("acc");
    expect(r.positions).toBe(1);
    expect(r.goldenCases).toBe(1);
    expect(r.findings).toBeGreaterThanOrEqual(1);
    expect(r.bySeverity?.error).toBeGreaterThanOrEqual(1);
    const persisted = upsertMany.mock.calls[0]![1];
    expect(persisted.map((f: { checkId: string }) => f.checkId)).toContain("golden_case_drift");
    // auto-resolve called with the tripping keys
    expect(autoResolveStale).toHaveBeenCalledWith("acc", expect.any(Set));
  });

  it("no shadow result → skipped, nothing persisted", async () => {
    const { deps, upsertMany } = makeDeps({
      shadowRepo: { findLatestForAccount: async () => null },
    });
    const r = await new AnomalyDetectorService(deps).scanAccount("acc");
    expect(r).toEqual({ skipped: true });
    expect(upsertMany).not.toHaveBeenCalled();
  });

  it("canonical matches golden within tolerance → no drift finding", async () => {
    const { deps, upsertMany } = makeDeps({
      shadowRepo: {
        findLatestForAccount: async () => ({ positions: [{ ...canonicalPos, startUsd: 237.8 }] }),
      },
    });
    await new AnomalyDetectorService(deps).scanAccount("acc");
    const persisted = upsertMany.mock.calls[0]![1];
    expect(persisted.map((f: { checkId: string }) => f.checkId)).not.toContain("golden_case_drift");
  });
});
