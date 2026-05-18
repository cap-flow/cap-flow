import { describe, expect, it } from "vitest";

import { normalizeBitgetTaxP2pRecord } from "./cex.p2p.bitget.js";

/**
 * Bitget retail P2P endpoint (`/api/v2/tax/p2p-record`) returns the
 * sparse tax-record shape — crypto leg only, no fiat. Pin this with
 * fixtures so a future field rename surfaces in CI rather than as
 * silent zero-row sync.
 */

describe("normalizeBitgetTaxP2pRecord — retail tax shape", () => {
  // Bitget /tax/p2p-record uses tax-perspective semantics:
  // transfer-IN = fiat came IN = user SOLD crypto
  // transfer-OUT = fiat went OUT = user BOUGHT crypto
  // Confirmed via real user data (2026-05-06 USDT-for-VND sale was
  // tagged transfer-in). Counter-intuitive vs. spot-wallet semantics.
  it("maps a transfer-in (fiat came in → user sold crypto) → side:sell", () => {
    const r = normalizeBitgetTaxP2pRecord({
      id: "152526631",
      coin: "USDT",
      p2pTaxType: "transfer-in",
      balance: "100",
      ts: "1755846320684",
    });
    expect(r).toEqual({
      id: "152526631",
      side: "sell",
      asset: "USDT",
      amount: 100,
      fiatCurrency: null,
      fiatAmount: null,
      unitPrice: null,
      counterparty: null,
      paymentMethod: null,
      status: "completed",
      executedAtMs: 1755846320684,
    });
  });

  it("maps a transfer-out (fiat went out → user bought crypto) → side:buy", () => {
    const r = normalizeBitgetTaxP2pRecord({
      id: "152526632",
      coin: "USDT",
      p2pTaxType: "transfer-out",
      balance: "50",
      ts: "1755846400000",
    });
    expect(r!.side).toBe("buy");
    expect(r!.amount).toBe(50);
  });

  it("normalizes asset to upper-case (Bitget sometimes returns lower)", () => {
    const r = normalizeBitgetTaxP2pRecord({
      id: "x1",
      coin: "usdt",
      p2pTaxType: "transfer-in",
      balance: "1",
      ts: "1755846320684",
    });
    expect(r!.asset).toBe("USDT");
  });

  it("accepts numeric balance and ts (some endpoints return numbers, not strings)", () => {
    const r = normalizeBitgetTaxP2pRecord({
      id: "x2",
      coin: "USDT",
      p2pTaxType: "transfer-in",
      balance: 1.5 as unknown as string,
      ts: 1755846320684 as unknown as string,
    });
    expect(r!.amount).toBe(1.5);
    expect(r!.executedAtMs).toBe(1755846320684);
  });
});

describe("normalizeBitgetTaxP2pRecord — rejects malformed rows", () => {
  it("returns null without id", () => {
    expect(
      normalizeBitgetTaxP2pRecord({
        coin: "USDT",
        p2pTaxType: "transfer-in",
        balance: "1",
        ts: "1755846320684",
      })
    ).toBeNull();
  });

  it("returns null without coin", () => {
    expect(
      normalizeBitgetTaxP2pRecord({
        id: "x",
        p2pTaxType: "transfer-in",
        balance: "1",
        ts: "1755846320684",
      })
    ).toBeNull();
  });

  it("returns null on unknown p2pTaxType (skip rather than guess)", () => {
    expect(
      normalizeBitgetTaxP2pRecord({
        id: "x",
        coin: "USDT",
        p2pTaxType: "reward",
        balance: "1",
        ts: "1755846320684",
      })
    ).toBeNull();
  });

  it("returns null when amount is zero or negative", () => {
    expect(
      normalizeBitgetTaxP2pRecord({
        id: "x",
        coin: "USDT",
        p2pTaxType: "transfer-in",
        balance: "0",
        ts: "1755846320684",
      })
    ).toBeNull();
  });

  it("returns null without timestamp", () => {
    expect(
      normalizeBitgetTaxP2pRecord({
        id: "x",
        coin: "USDT",
        p2pTaxType: "transfer-in",
        balance: "1",
        ts: "0",
      })
    ).toBeNull();
  });
});
