import { describe, expect, it } from "vitest";

import { normalizeCcxtInternalTransfer } from "./cex.internal-transfers.js";

describe("normalizeCcxtInternalTransfer", () => {
  it("принимает каноничный CCXT shape", () => {
    const r = normalizeCcxtInternalTransfer({
      id: "tx-123",
      timestamp: 1735689600000, // 2025-01-01
      currency: "USDT",
      amount: 1000,
      fromAccount: "spot",
      toAccount: "earn",
      status: "ok",
    });
    expect(r).toBeTruthy();
    expect(r?.id).toBe("tx-123");
    expect(r?.asset).toBe("USDT");
    expect(r?.amount).toBe(1000);
    expect(r?.fromAccount).toBe("spot");
    expect(r?.toAccount).toBe("earn");
    expect(r?.executedAtMs).toBe(1735689600000);
  });

  it("нормализует aliases account-types", () => {
    const r = normalizeCcxtInternalTransfer({
      id: "x",
      timestamp: 1,
      currency: "BTC",
      amount: 0.1,
      fromAccount: "MAIN",
      toAccount: "Savings",
    });
    expect(r?.fromAccount).toBe("spot");
    expect(r?.toAccount).toBe("earn");
  });

  it("сохраняет sub-account name as-is", () => {
    const r = normalizeCcxtInternalTransfer({
      id: "x",
      timestamp: 1,
      currency: "ETH",
      amount: 1,
      fromAccount: "spot",
      toAccount: "sub-trading-001",
    });
    expect(r?.toAccount).toBe("sub-trading-001");
  });

  it("парсит datetime если timestamp отсутствует", () => {
    const r = normalizeCcxtInternalTransfer({
      id: "x",
      datetime: "2026-01-01T00:00:00Z",
      currency: "USDT",
      amount: 50,
      fromAccount: "spot",
      toAccount: "funding",
    });
    expect(r).toBeTruthy();
    expect(r?.executedAtMs).toBe(Date.parse("2026-01-01T00:00:00Z"));
  });

  it("отбрасывает row без id", () => {
    expect(
      normalizeCcxtInternalTransfer({
        currency: "USDT",
        amount: 100,
        timestamp: 1,
        fromAccount: "spot",
        toAccount: "earn",
      }),
    ).toBeNull();
  });

  it("отбрасывает невалидный amount (0, negative, NaN)", () => {
    for (const v of [0, -1, "abc", null, undefined]) {
      expect(
        normalizeCcxtInternalTransfer({
          id: "x",
          currency: "USDT",
          amount: v as never,
          timestamp: 1,
          fromAccount: "spot",
          toAccount: "earn",
        }),
      ).toBeNull();
    }
  });

  it("отбрасывает оба unknown account-type (бесполезный row)", () => {
    expect(
      normalizeCcxtInternalTransfer({
        id: "x",
        currency: "USDT",
        amount: 1,
        timestamp: 1,
      }),
    ).toBeNull();
  });

  it("status default 'ok' если отсутствует", () => {
    const r = normalizeCcxtInternalTransfer({
      id: "x",
      currency: "USDT",
      amount: 1,
      timestamp: 1,
      fromAccount: "spot",
      toAccount: "earn",
    });
    expect(r?.status).toBe("ok");
  });
});
