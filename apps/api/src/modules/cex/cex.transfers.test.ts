import { describe, expect, it } from "vitest";

import { normalizeCcxtTransfer } from "./cex.transfers.js";

/**
 * CCXT deposit/withdrawal shape pinned against the variations we see
 * in the wild — Bitget, Bybit, OKX all expose subtly different field
 * sets, and we accept the unions here so the service layer doesn't
 * need exchange-specific branching.
 */

describe("normalizeCcxtTransfer — canonical shape", () => {
  it("maps a standard CCXT withdrawal", () => {
    const out = normalizeCcxtTransfer({
      id: "TX-001",
      txid:
        "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      type: "withdrawal",
      currency: "ETH",
      amount: "0.015",
      address: "0xMyWallet",
      network: "ETH",
      fee: { cost: "0.0001", currency: "ETH" },
      status: "ok",
      timestamp: 1700000000000,
    });
    expect(out).toEqual({
      id: "TX-001",
      direction: "withdrawal",
      asset: "ETH",
      amount: 0.015,
      feeAmount: 0.0001,
      feeCurrency: "ETH",
      network: "ETH",
      address: "0xMyWallet",
      txHash:
        "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      status: "ok",
      executedAtMs: 1700000000000,
    });
  });

  it("maps a standard CCXT deposit", () => {
    const out = normalizeCcxtTransfer({
      id: "DEP-001",
      txid: "0x1234",
      type: "deposit",
      currency: "USDT",
      amount: 100,
      address: "0xBitgetDeposit",
      network: "ARBITRUM",
      status: "ok",
      timestamp: 1700000000000,
    });
    expect(out!.direction).toBe("deposit");
    expect(out!.asset).toBe("USDT");
    expect(out!.amount).toBe(100);
    expect(out!.network).toBe("ARBITRUM");
  });
});

describe("normalizeCcxtTransfer — synonyms and fallbacks", () => {
  it("uses fallbackDirection when `type` is absent (Bitget per-endpoint queries)", () => {
    const out = normalizeCcxtTransfer(
      {
        id: "x",
        currency: "ETH",
        amount: "0.01",
        timestamp: 1700000000000,
        status: "ok",
      },
      "withdrawal",
    );
    expect(out!.direction).toBe("withdrawal");
  });

  it("falls back to txid as id when `id` is missing", () => {
    const out = normalizeCcxtTransfer({
      txid: "0xabc",
      type: "deposit",
      currency: "ETH",
      amount: "0.01",
      timestamp: 1700000000000,
      status: "ok",
    });
    expect(out!.id).toBe("0xabc");
    expect(out!.txHash).toBe("0xabc");
  });

  it("accepts `chain` as a synonym for `network`", () => {
    const out = normalizeCcxtTransfer({
      id: "x",
      type: "deposit",
      currency: "USDT",
      amount: "1",
      chain: "tron",
      timestamp: 1700000000000,
      status: "ok",
    });
    expect(out!.network).toBe("TRON");
  });

  it("falls back to ISO datetime when `timestamp` is missing", () => {
    const out = normalizeCcxtTransfer({
      id: "x",
      type: "deposit",
      currency: "ETH",
      amount: "0.01",
      datetime: "2023-11-14T22:13:20.000Z",
      status: "ok",
    });
    expect(out!.executedAtMs).toBe(Date.parse("2023-11-14T22:13:20.000Z"));
  });

  it("accepts a numeric `fee` (no object) as the asset-denominated cost", () => {
    const out = normalizeCcxtTransfer({
      id: "x",
      type: "withdrawal",
      currency: "ETH",
      amount: "0.01",
      fee: 0.0005,
      timestamp: 1700000000000,
      status: "ok",
    });
    expect(out!.feeAmount).toBe(0.0005);
    expect(out!.feeCurrency).toBe("ETH");
  });

  it("normalizes `withdraw` (no -al) to `withdrawal`", () => {
    const out = normalizeCcxtTransfer({
      id: "x",
      type: "withdraw",
      currency: "ETH",
      amount: "0.01",
      timestamp: 1700000000000,
      status: "ok",
    });
    expect(out!.direction).toBe("withdrawal");
  });
});

describe("normalizeCcxtTransfer — rejects malformed", () => {
  it("returns null when id, txid and hash are all missing", () => {
    expect(
      normalizeCcxtTransfer({
        type: "withdrawal",
        currency: "ETH",
        amount: "0.01",
        timestamp: 1700000000000,
        status: "ok",
      }),
    ).toBeNull();
  });

  it("returns null when type is missing AND no fallbackDirection given", () => {
    expect(
      normalizeCcxtTransfer({
        id: "x",
        currency: "ETH",
        amount: "0.01",
        timestamp: 1700000000000,
        status: "ok",
      }),
    ).toBeNull();
  });

  it("returns null when amount is zero or negative", () => {
    expect(
      normalizeCcxtTransfer({
        id: "x",
        type: "deposit",
        currency: "ETH",
        amount: "0",
        timestamp: 1700000000000,
        status: "ok",
      }),
    ).toBeNull();
  });
});
