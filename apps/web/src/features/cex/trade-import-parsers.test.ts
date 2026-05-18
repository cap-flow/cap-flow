/**
 * Tests для trade-import парсеров (Bybit CSV + BingX XLSX).
 * Сами файлы пользователя не доступны в тестах — используем мини-фикстуры
 * which 1-в-1 повторяют структуру реальных файлов.
 */
import { describe, expect, it } from "vitest";

import {
  normalizeBingxTimestamp,
  parseBybitCsv,
} from "./trade-import-parsers";

const BYBIT_FIXTURE = `UID: 281915315,Company Name: ,Country:
Uid,Spot Pairs,Order Type,Direction,Filled Value,Filled Price,Filled Quantity,Fees,Transaction ID,Order No.,Timestamp (UTC+0)
281915315,BTCUSDT,LIMIT,BUY,4478.05780000000000000000,97100.00000000000000000000,0.04611800000000000000,0.00004611800000000000,2290000000522832993,1836393090823494400,2024-12-09 19:48:23
281915315,LTCUSDT,MARKET,BUY,20.64617910000000000000,104.49000000000000000000,0.19759000000000000000,0.00035566200000000000,2200000000570297153,1849440883666328320,2024-12-26 09:48:53
`;

describe("parseBybitCsv — real fixture", () => {
  it("парсит 2 валидных trade из реального Bybit CSV", () => {
    const r = parseBybitCsv(BYBIT_FIXTURE);
    expect(r.source).toBe("bybit_csv");
    expect(r.rows).toHaveLength(2);
    expect(r.skipped).toBe(0);
  });

  it("корректно разделяет concat pair BTCUSDT → BTC/USDT", () => {
    const r = parseBybitCsv(BYBIT_FIXTURE);
    expect(r.rows[0]!.symbol).toBe("BTC/USDT");
    expect(r.rows[1]!.symbol).toBe("LTC/USDT");
  });

  it("конвертирует BUY → 'buy' lowercase", () => {
    const r = parseBybitCsv(BYBIT_FIXTURE);
    expect(r.rows[0]!.side).toBe("buy");
    expect(r.rows[1]!.side).toBe("buy");
  });

  it("использует Transaction ID как exchangeTradeId", () => {
    const r = parseBybitCsv(BYBIT_FIXTURE);
    expect(r.rows[0]!.exchangeTradeId).toBe("2290000000522832993");
  });

  it("конвертирует UTC+0 timestamp в ISO", () => {
    const r = parseBybitCsv(BYBIT_FIXTURE);
    expect(r.rows[0]!.executedAt).toBe("2024-12-09T19:48:23Z");
    expect(new Date(r.rows[0]!.executedAt).getUTCHours()).toBe(19);
  });

  it("числа: amount, price, cost", () => {
    const r = parseBybitCsv(BYBIT_FIXTURE);
    expect(r.rows[0]!.amount).toBe(0.046118);
    expect(r.rows[0]!.price).toBe(97100);
    expect(r.rows[0]!.cost).toBeCloseTo(4478.0578, 4);
  });

  it("error для не-Bybit CSV без header'а", () => {
    const r = parseBybitCsv("hello,world\n1,2");
    expect(r.error).toMatch(/Bybit CSV/i);
    expect(r.rows).toHaveLength(0);
  });

  it("skipped для строк с zero amount", () => {
    const csv = `UID: 1
Uid,Spot Pairs,Order Type,Direction,Filled Value,Filled Price,Filled Quantity,Fees,Transaction ID,Order No.,Timestamp (UTC+0)
1,BTCUSDT,LIMIT,BUY,4478.05,97100,0,0,T-BAD,O-1,2024-12-09 19:48:23
1,BTCUSDT,LIMIT,BUY,4478.05,97100,0.04,0,T-OK,O-2,2024-12-09 19:48:24
`;
    const r = parseBybitCsv(csv);
    expect(r.rows).toHaveLength(1);
    expect(r.skipped).toBe(1);
  });

  it("skipped для строк с unknown side", () => {
    const csv = `UID: 1
Uid,Spot Pairs,Order Type,Direction,Filled Value,Filled Price,Filled Quantity,Fees,Transaction ID,Order No.,Timestamp (UTC+0)
1,BTCUSDT,LIMIT,UNKNOWN,4478,97100,0.04,0,T-BAD,O-1,2024-12-09 19:48:23
`;
    const r = parseBybitCsv(csv);
    expect(r.rows).toHaveLength(0);
    expect(r.skipped).toBe(1);
  });
});

describe("normalizeBingxTimestamp — handles both BingX formats", () => {
  it("native ISO с +08:00 — конвертит правильно (-8h из BingX local)", () => {
    // 2024 формат files: full ISO with offset
    expect(normalizeBingxTimestamp("2024-11-26T06:59:57.000+08:00")).toBe(
      "2024-11-25T22:59:57.000Z",
    );
  });

  it("без offset с 'T' — трактует как BingX UTC+8 и shift'ит в UTC", () => {
    // Bug fix: 2025 формат без offset. Раньше JS брал как UTC и
    // trade оказывался на 8 часов позже withdrawal'а. Теперь правильно
    // shift'ит на -8h.
    expect(normalizeBingxTimestamp("2025-09-28T23:36:25")).toBe(
      "2025-09-28T15:36:25.000Z",
    );
  });

  it("без offset с пробелом вместо T — то же поведение", () => {
    expect(normalizeBingxTimestamp("2025-09-28 23:36:25")).toBe(
      "2025-09-28T15:36:25.000Z",
    );
  });

  it("UTC Z suffix — оставляет как UTC", () => {
    expect(normalizeBingxTimestamp("2025-09-28T15:36:25Z")).toBe(
      "2025-09-28T15:36:25.000Z",
    );
  });

  it("явный +0000 — UTC (никакого shift'а)", () => {
    expect(normalizeBingxTimestamp("2025-09-28T15:36:25+00:00")).toBe(
      "2025-09-28T15:36:25.000Z",
    );
  });

  it("другой timezone (например +03:00) — не трогает", () => {
    expect(normalizeBingxTimestamp("2025-09-28T18:36:25+03:00")).toBe(
      "2025-09-28T15:36:25.000Z",
    );
  });

  it("garbage → null", () => {
    expect(normalizeBingxTimestamp("not-a-date")).toBeNull();
    expect(normalizeBingxTimestamp("")).toBeNull();
  });

  it("реальный bug-case: WBTC trade Bob'а должен быть до withdrawal", () => {
    // BingX XLSX за 2025-09-28: trade в 23:36:25 локально (UTC+8) =
    // 15:36:25 UTC, что РАНЬШЕ withdrawal'а в 16:17 UTC. До fix'а
    // trade парсился как 23:36:25 UTC → ПОСЛЕ withdrawal'а →
    // CexCostBasisService строил chain неправильно.
    const trade = new Date(normalizeBingxTimestamp("2025-09-28T23:36:25")!);
    const withdrawal = new Date("2025-09-28T16:17:00Z");
    expect(trade.getTime()).toBeLessThan(withdrawal.getTime());
  });
});
