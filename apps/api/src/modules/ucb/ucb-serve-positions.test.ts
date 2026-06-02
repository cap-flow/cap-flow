import { describe, expect, it } from "vitest";

import { decideServePositions } from "./ucb-serve-positions.js";
import type { UcbShadowResult } from "./ucb-shadow.repository.js";

function shadow(overrides: Partial<UcbShadowResult> = {}): UcbShadowResult {
  return {
    id: "row-1",
    accountId: "acc-1",
    computedAt: new Date("2026-06-02T12:00:00Z"),
    trigger: "refresh",
    lotMethodology: "FIFO",
    positionCount: 1,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    positions: [{ id: "POS-001", startUsd: 100 } as any],
    engineVersion: "test-engine",
    diffSummary: null,
    error: null,
    ...overrides,
  };
}

describe("decideServePositions (B6 serve/fallback core)", () => {
  it("flag OFF → fall back regardless of a fresh shadow", () => {
    const d = decideServePositions({
      flagEnabled: false,
      shadow: shadow(),
      latestSnapshotAt: new Date("2026-06-02T11:00:00Z"),
    });
    expect(d.serve).toBe(false);
    expect(d.reason).toBe("flag_off");
    expect(d.positions).toBeNull();
  });

  it("no shadow row → fall back", () => {
    const d = decideServePositions({
      flagEnabled: true,
      shadow: null,
      latestSnapshotAt: null,
    });
    expect(d.serve).toBe(false);
    expect(d.reason).toBe("no_shadow");
  });

  it("shadow recorded an error → fall back", () => {
    const d = decideServePositions({
      flagEnabled: true,
      shadow: shadow({ error: "boom", positions: [] }),
      latestSnapshotAt: null,
    });
    expect(d.serve).toBe(false);
    expect(d.reason).toBe("shadow_error");
  });

  it("snapshot newer than shadow → stale → fall back", () => {
    const d = decideServePositions({
      flagEnabled: true,
      shadow: shadow({ computedAt: new Date("2026-06-02T10:00:00Z") }),
      latestSnapshotAt: new Date("2026-06-02T12:00:00Z"),
    });
    expect(d.serve).toBe(false);
    expect(d.reason).toBe("stale");
  });

  it("flag ON + fresh shadow → serve the server positions", () => {
    const d = decideServePositions({
      flagEnabled: true,
      shadow: shadow({ computedAt: new Date("2026-06-02T12:00:00Z") }),
      latestSnapshotAt: new Date("2026-06-02T11:59:00Z"),
    });
    expect(d.serve).toBe(true);
    expect(d.reason).toBe("served");
    expect(d.positions).toHaveLength(1);
    expect(d.computedAt).toBe("2026-06-02T12:00:00.000Z");
    expect(d.lotMethodology).toBe("FIFO");
    expect(d.engineVersion).toBe("test-engine");
  });

  it("shadow exactly as new as the snapshot → fresh (not stale)", () => {
    const t = new Date("2026-06-02T12:00:00Z");
    const d = decideServePositions({
      flagEnabled: true,
      shadow: shadow({ computedAt: t }),
      latestSnapshotAt: t,
    });
    expect(d.serve).toBe(true);
    expect(d.reason).toBe("served");
  });

  it("no snapshot yet → freshness check skipped, serves", () => {
    const d = decideServePositions({
      flagEnabled: true,
      shadow: shadow(),
      latestSnapshotAt: null,
    });
    expect(d.serve).toBe(true);
    expect(d.reason).toBe("served");
  });
});
