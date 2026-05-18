/**
 * UCB B4: tests для `normalizeCcxtLedger` — нормализация CCXT ledger
 * entries в наш unified `CexLedgerLine` shape.
 *
 * CCXT LedgerEntry canonical shape:
 *   {
 *     id, info, direction ('in'|'out'), account, referenceId,
 *     referenceAccount, type, currency, amount, before, after,
 *     status, fee: { cost, currency }, timestamp, datetime
 *   }
 *
 * Per-exchange variations:
 *   - Bitget: type values "trade" | "transaction" | "transfer" | "fee" |
 *             "rebate" | "deposit" | "withdrawal"
 *   - Bybit:  uses "currency" + custom types like "TRADE", "BORROW", etc.
 *   - Bingx:  varies by sub-API (spot/futures/p2p)
 *
 * Цель: разные CCXT shapes → consistent CexLedgerLine для DB storage.
 */
import { describe, expect, it } from "vitest";

import { normalizeCcxtLedger } from "./cex.ledger.js";

describe("normalizeCcxtLedger", () => {
  it("canonical CCXT entry → normalized line", () => {
    const ccxtEntry = {
      id: "12345",
      direction: "in",
      account: "spot",
      referenceId: "trade-789",
      type: "trade",
      currency: "USDT",
      amount: 100,
      status: "ok",
      fee: { cost: 0.1, currency: "USDT" },
      timestamp: 1700000000000,
      info: { raw: "data" },
    };
    const [line] = normalizeCcxtLedger([ccxtEntry]);
    expect(line).toBeDefined();
    expect(line.exchangeEntryId).toBe("12345");
    expect(line.account).toBe("spot");
    expect(line.asset).toBe("USDT");
    expect(line.amount).toBe(100);
    expect(line.direction).toBe("in");
    expect(line.type).toBe("trade");
    expect(line.referenceId).toBe("trade-789");
    expect(line.feeAmount).toBe(0.1);
    expect(line.feeCurrency).toBe("USDT");
    expect(line.status).toBe("ok");
    expect(line.executedAtMs).toBe(1700000000000);
  });

  it("withdrawal entry → out direction", () => {
    const entry = {
      id: "wd-1",
      direction: "out",
      account: "spot",
      type: "transaction",
      currency: "BTC",
      amount: 0.5,
      status: "ok",
      timestamp: 1700000000000,
    };
    const [line] = normalizeCcxtLedger([entry]);
    expect(line.direction).toBe("out");
    expect(line.type).toBe("withdrawal"); // "transaction" + out → withdrawal
  });

  it("deposit entry → in direction", () => {
    const entry = {
      id: "dp-1",
      direction: "in",
      account: "spot",
      type: "transaction",
      currency: "USDT",
      amount: 1000,
      status: "ok",
      timestamp: 1700000000000,
    };
    const [line] = normalizeCcxtLedger([entry]);
    expect(line.direction).toBe("in");
    expect(line.type).toBe("deposit"); // "transaction" + in → deposit
  });

  it("interest/rebate types preserved", () => {
    const entries = [
      { id: "1", direction: "in", type: "interest", currency: "USDT", amount: 5, status: "ok", timestamp: 1700000000000 },
      { id: "2", direction: "in", type: "rebate", currency: "USDT", amount: 2, status: "ok", timestamp: 1700000000000 },
      { id: "3", direction: "in", type: "cashback", currency: "USDT", amount: 1, status: "ok", timestamp: 1700000000000 },
    ];
    const lines = normalizeCcxtLedger(entries);
    expect(lines[0].type).toBe("interest");
    expect(lines[1].type).toBe("rebate");
    expect(lines[2].type).toBe("rebate"); // cashback normalized to rebate
  });

  it("derives direction from amount sign when missing", () => {
    // Some exchanges don't set direction; use amount sign
    const entries = [
      { id: "1", account: "spot", type: "trade", currency: "USDT", amount: 100, status: "ok", timestamp: 1700000000000 },
      { id: "2", account: "spot", type: "trade", currency: "USDT", amount: -50, status: "ok", timestamp: 1700000000000 },
    ];
    const lines = normalizeCcxtLedger(entries);
    expect(lines[0].direction).toBe("in");
    expect(lines[1].direction).toBe("out");
    expect(lines[1].amount).toBe(50); // store as positive (direction captures sign)
  });

  it("invalid entries skipped", () => {
    const entries = [
      { id: "1", direction: "in", type: "trade", currency: "USDT", amount: 100, status: "ok", timestamp: 1700000000000 }, // valid
      { id: "", direction: "in", amount: 50, currency: "USDT", status: "ok", timestamp: 1700000000000 }, // empty id
      null,
      { id: "3", currency: "USDT", amount: 0, status: "ok", timestamp: 1700000000000 }, // zero amount
      { id: "4", direction: "in", type: "trade", amount: 100, status: "ok", timestamp: 1700000000000 }, // missing currency
    ];
    const lines = normalizeCcxtLedger(entries);
    expect(lines).toHaveLength(1);
    expect(lines[0].exchangeEntryId).toBe("1");
  });

  it("preserves raw info for debug/re-classification", () => {
    const entry = {
      id: "1", direction: "in", type: "trade", currency: "USDT", amount: 100,
      status: "ok", timestamp: 1700000000000,
      info: { exchangeSpecific: "field" },
    };
    const [line] = normalizeCcxtLedger([entry]);
    expect(line.raw).toEqual({ exchangeSpecific: "field" });
  });

  it("uses datetime when timestamp missing (ISO fallback)", () => {
    const entry = {
      id: "1", direction: "in", type: "trade", currency: "USDT", amount: 100,
      status: "ok", datetime: "2024-01-15T12:00:00Z",
    };
    const [line] = normalizeCcxtLedger([entry]);
    expect(line.executedAtMs).toBe(new Date("2024-01-15T12:00:00Z").getTime());
  });

  it("transfer type (internal sub-account move)", () => {
    const entry = {
      id: "tr-1",
      direction: "out",
      account: "spot",
      referenceAccount: "funding",
      type: "transfer",
      currency: "USDT",
      amount: 500,
      status: "ok",
      timestamp: 1700000000000,
    };
    const [line] = normalizeCcxtLedger([entry]);
    expect(line.type).toBe("transfer");
  });

  it("fee type preserved separately from trade fee", () => {
    // Some exchanges record fees as separate ledger entries
    const entry = {
      id: "fee-1",
      direction: "out",
      account: "spot",
      type: "fee",
      currency: "USDT",
      amount: 0.5,
      status: "ok",
      timestamp: 1700000000000,
    };
    const [line] = normalizeCcxtLedger([entry]);
    expect(line.type).toBe("fee");
    expect(line.amount).toBe(0.5);
    expect(line.direction).toBe("out");
  });
});
