import { describe, expect, it } from "vitest";

import { addMonths, periodEnd } from "./period.js";

/**
 * `addMonths` — calendar-month arithmetic that respects:
 *   - real months (not 30-day approximation)
 *   - leap years
 *   - end-of-month clamping (Jan 31 + 1mo = Feb 28/29, not Mar 3)
 *   - timezone consistency (UTC)
 *
 * Replaces `from.getTime() + plan.months * 30 * 86_400_000` in
 * billing.service.ts and payment-monitor.service.ts, where the 30-day
 * fixed-month approximation was silently shortening annual plans by
 * 5 days (~1.4% lost time per year).
 */
describe("addMonths — calendar math", () => {
  it("adds whole months for typical mid-month dates", () => {
    const r = addMonths(new Date("2026-05-14T12:00:00Z"), 3);
    expect(r.toISOString()).toBe("2026-08-14T12:00:00.000Z");
  });

  it("adds 12 months → exactly 1 year (NOT 360 days)", () => {
    const from = new Date("2026-05-14T00:00:00Z");
    const r = addMonths(from, 12);
    expect(r.toISOString()).toBe("2027-05-14T00:00:00.000Z");
    // The old 30-day approx would give 2027-05-09, losing 5 days.
    const old30Day = new Date(from.getTime() + 12 * 30 * 86_400_000);
    expect(r.getTime() - old30Day.getTime()).toBe(5 * 86_400_000);
  });

  it("clamps end-of-month: Jan 31 + 1 month = Feb 28 in non-leap year", () => {
    const r = addMonths(new Date("2025-01-31T00:00:00Z"), 1);
    expect(r.toISOString()).toBe("2025-02-28T00:00:00.000Z");
  });

  it("clamps end-of-month: Jan 31 + 1 month = Feb 29 in leap year", () => {
    const r = addMonths(new Date("2024-01-31T00:00:00Z"), 1);
    expect(r.toISOString()).toBe("2024-02-29T00:00:00.000Z");
  });

  it("Feb 29 + 12 months in leap year → Feb 28 next year", () => {
    const r = addMonths(new Date("2024-02-29T00:00:00Z"), 12);
    expect(r.toISOString()).toBe("2025-02-28T00:00:00.000Z");
  });

  it("crosses year boundary", () => {
    const r = addMonths(new Date("2026-11-30T00:00:00Z"), 3);
    // Nov 30 + 3 months = Feb 28/29; 2027 is not leap.
    expect(r.toISOString()).toBe("2027-02-28T00:00:00.000Z");
  });

  it("preserves time-of-day and millisecond precision", () => {
    const r = addMonths(new Date("2026-05-14T13:37:42.123Z"), 6);
    expect(r.toISOString()).toBe("2026-11-14T13:37:42.123Z");
  });

  it("zero months is identity", () => {
    const from = new Date("2026-05-14T12:00:00Z");
    const r = addMonths(from, 0);
    expect(r.getTime()).toBe(from.getTime());
  });

  it("does not mutate the source Date", () => {
    const from = new Date("2026-05-14T12:00:00Z");
    const before = from.getTime();
    addMonths(from, 6);
    expect(from.getTime()).toBe(before);
  });
});

describe("periodEnd — billing convenience", () => {
  it("3-month plan from May 14 → Aug 14", () => {
    const r = periodEnd(new Date("2026-05-14T00:00:00Z"), 3);
    expect(r.toISOString()).toBe("2026-08-14T00:00:00.000Z");
  });

  it("12-month plan from May 14 → next year, same day", () => {
    const r = periodEnd(new Date("2026-05-14T00:00:00Z"), 12);
    expect(r.toISOString()).toBe("2027-05-14T00:00:00.000Z");
  });

  it("rejects non-positive months", () => {
    expect(() => periodEnd(new Date(), 0)).toThrow();
    expect(() => periodEnd(new Date(), -1)).toThrow();
  });
});
