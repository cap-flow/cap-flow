import { describe, expect, it } from "vitest";

import { formatAmountForLedger } from "./payment-precision.js";

/**
 * L3 (2026-05-14): ledger precision for USDT (and other 6-decimal
 * stablecoins). Pre-L3 code did `amount.toFixed(2)` which silently
 * lost up to ~$0.01 PER tx → drift between on-chain truth and our
 * `user_payments.amount_usd`. Over thousands of payments that's a
 * noticeable reconciliation discrepancy.
 *
 * Contract: format with at least 6 decimals, strip useless trailing
 * zeros, never round (truncate to keep ledger ≤ on-chain).
 */
describe("formatAmountForLedger", () => {
  it("preserves USDT 6-decimal precision", () => {
    expect(formatAmountForLedger(100.123456)).toBe("100.123456");
  });

  it("strips trailing zeros for cleaner storage", () => {
    expect(formatAmountForLedger(100.5)).toBe("100.5");
    expect(formatAmountForLedger(100)).toBe("100");
  });

  it("does NOT round half-up (no silent surplus for us)", () => {
    // 100.999999 must NOT become 101.00. We keep 100.999999.
    expect(formatAmountForLedger(100.999999)).toBe("100.999999");
  });

  it("handles sub-cent amounts (microUSDT)", () => {
    expect(formatAmountForLedger(0.000001)).toBe("0.000001");
  });

  it("handles whole-number amounts", () => {
    expect(formatAmountForLedger(180)).toBe("180");
  });

  it("rejects negative or non-finite amounts (use insertRefund for negatives)", () => {
    expect(() => formatAmountForLedger(-1)).toThrow();
    expect(() => formatAmountForLedger(NaN)).toThrow();
    expect(() => formatAmountForLedger(Infinity)).toThrow();
  });

  it("truncates excessive precision (more than 8 decimals)", () => {
    // Float repr of 0.1 + 0.2 is 0.30000000000000004 — must not be
    // stored as that monster.
    expect(formatAmountForLedger(0.1 + 0.2)).toMatch(/^0\.3\d{0,8}$/);
    // Verify the length is capped at 10 chars (0.XXXXXXXX = 10).
    expect(formatAmountForLedger(0.1 + 0.2).length).toBeLessThanOrEqual(10);
  });
});
