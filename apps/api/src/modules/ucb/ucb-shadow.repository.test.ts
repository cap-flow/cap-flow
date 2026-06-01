/**
 * B5 — ucb_shadow_results value mappers (pure). The drizzle insert/select is
 * type-checked against the schema; this covers the derivation/defaulting logic.
 */
import { describe, expect, it } from "vitest";

import {
  rowToShadowResult,
  toInsertValues,
  type UcbShadowWriteInput,
} from "./ucb-shadow.repository.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pos = (startUsd: number) => ({ startUsd }) as any;

const baseInput: UcbShadowWriteInput = {
  accountId: "acc-1",
  trigger: "refresh",
  lotMethodology: "LIFO",
  positions: [pos(100), pos(200)],
  engineVersion: "ucb@0.1.0+abc123",
};

describe("toInsertValues", () => {
  it("derives positionCount and defaults nullables to null", () => {
    const v = toInsertValues(baseInput);
    expect(v.positionCount).toBe(2);
    expect(v.diffSummary).toBeNull();
    expect(v.error).toBeNull();
    expect(v.accountId).toBe("acc-1");
    expect(v.trigger).toBe("refresh");
    expect(v.lotMethodology).toBe("LIFO");
    expect(v.engineVersion).toBe("ucb@0.1.0+abc123");
  });

  it("passes error + diffSummary through (fail-soft / diff write)", () => {
    const summary = {
      divergentCount: 0,
      matchedCount: 2,
      clientOnlyCount: 0,
      serverOnlyCount: 0,
      thresholdUsd: 1,
      deltas: [],
    };
    const v = toInsertValues({
      ...baseInput,
      positions: [],
      error: "boom",
      diffSummary: summary,
    });
    expect(v.positionCount).toBe(0);
    expect(v.error).toBe("boom");
    expect(v.diffSummary).toEqual(summary);
  });
});

describe("rowToShadowResult", () => {
  it("maps a row, casts positions, nulls absent diff/error", () => {
    const computedAt = new Date("2026-06-01T00:00:00.000Z");
    const r = rowToShadowResult({
      id: "row-1",
      accountId: "acc-1",
      computedAt,
      trigger: "refresh",
      lotMethodology: "FIFO",
      positionCount: 1,
      positions: [pos(42)],
      engineVersion: "ucb@0.1.0",
      diffSummary: null,
      error: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(r.id).toBe("row-1");
    expect(r.computedAt).toBe(computedAt);
    expect(r.positions).toHaveLength(1);
    expect(r.positions[0]!.startUsd).toBe(42);
    expect(r.diffSummary).toBeNull();
    expect(r.error).toBeNull();
  });

  it("tolerates null positions jsonb → empty array", () => {
    const r = rowToShadowResult({
      id: "row-2",
      accountId: "acc-1",
      computedAt: new Date(),
      trigger: "manual",
      lotMethodology: "FIFO",
      positionCount: 0,
      positions: null,
      engineVersion: "x",
      diffSummary: null,
      error: "compute failed",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(r.positions).toEqual([]);
    expect(r.error).toBe("compute failed");
  });
});
