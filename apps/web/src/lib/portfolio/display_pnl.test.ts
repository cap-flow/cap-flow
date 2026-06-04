import { describe, expect, it } from "vitest";

import { MIN_START_USD_FOR_PCT, leverageDisplay, safePnlPct } from "./display_pnl";

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

describe("leverageDisplay — from live protocol debt (Option B)", () => {
  it("no debt → null (plain LP / staking: NO leverage badge)", () => {
    // mmaksimuk Velodrome WETH/WBTC: currentUsd ~$103, debt $0. The old
    // netStartUsd-based path falsely showed 2.3× here; live-debt path shows none.
    expect(leverageDisplay(102.87, 0)).toBeNull();
  });

  it("real debt → net exposure + leverage (Extra Finance OP: $183.45 / debt $82.64)", () => {
    const r = leverageDisplay(183.45, 82.64);
    expect(r).not.toBeNull();
    expect(r!.netUsd).toBeCloseTo(100.81, 2);
    expect(r!.leverage).toBeCloseTo(1.82, 2);
  });

  it("dust debt below max($1, 1%·currentUsd) → null (noise, no badge)", () => {
    expect(leverageDisplay(5000, 4)).toBeNull(); // 4 < max(1, 50)
    expect(leverageDisplay(50, 0.5)).toBeNull(); // 0.5 < max(1, 0.5)=1
  });

  it("debt just above the threshold → shown", () => {
    const r = leverageDisplay(1000, 11); // 11 > max(1, 10)
    expect(r).not.toBeNull();
    expect(r!.netUsd).toBeCloseTo(989, 2);
  });

  it("underwater (debt ≥ current) → net clamped to 0, leverage null (no ×, but flagged)", () => {
    const r = leverageDisplay(100, 100);
    expect(r).not.toBeNull();
    expect(r!.netUsd).toBe(0);
    expect(r!.leverage).toBeNull();
  });

  it("returns null for non-finite inputs", () => {
    expect(leverageDisplay(Number.NaN, 50)).toBeNull();
    expect(leverageDisplay(100, Number.POSITIVE_INFINITY)).toBeNull();
  });
});
