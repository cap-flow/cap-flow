import { describe, expect, it } from "vitest";

import { MIN_START_USD_FOR_PCT, safePnlPct } from "./display_pnl";

describe("safePnlPct", () => {
  it("computes a normal percentage", () => {
    expect(safePnlPct(50, 200)).toBe(25);
    expect(safePnlPct(-100, 200)).toBe(-50);
    expect(safePnlPct(0, 200)).toBe(0);
  });

  it("returns null for the Velodrome dust startUsd (1.6e-15) that the bare >0 guard let through", () => {
    // POS-011: startUsd collapsed to ~1.64e-15, currentUsd ~$112 →
    // bare `startUsd > 0` produced +6.8e18 %. Must be null now.
    expect(safePnlPct(112.31, 1.64e-15)).toBeNull();
  });

  it("returns null for exactly zero startUsd", () => {
    expect(safePnlPct(112, 0)).toBeNull();
  });

  it("returns null just below the 1-cent threshold", () => {
    expect(safePnlPct(100, MIN_START_USD_FOR_PCT - 0.0001)).toBeNull();
  });

  it("computes at the threshold and above", () => {
    expect(safePnlPct(0, MIN_START_USD_FOR_PCT)).toBe(0);
    expect(safePnlPct(1, 1)).toBe(100);
  });

  it("returns null for non-finite inputs", () => {
    expect(safePnlPct(100, Number.NaN)).toBeNull();
    expect(safePnlPct(Number.POSITIVE_INFINITY, 100)).toBeNull();
    expect(safePnlPct(100, Number.POSITIVE_INFINITY)).toBeNull();
  });
});
