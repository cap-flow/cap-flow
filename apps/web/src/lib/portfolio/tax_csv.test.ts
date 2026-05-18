/**
 * Tax T2: tests for CSV exporter.
 *
 * Format goals:
 *   - Capflow-native columns + Koinly Universal-ish — exportable в любой
 *     CSV-aware tax tool.
 *   - RFC 4180 escaping (double quotes, comma в полях, newlines).
 *   - ISO 8601 timestamps (UTC).
 *   - Numeric fields с фиксированной precision: USD = 2 decimals, amount = 8.
 */
import { describe, expect, it } from "vitest";

import { exportTaxEventsToCsv } from "./tax_csv";
import type { TaxEvent } from "./tax_events";

function ev(args: Partial<TaxEvent>): TaxEvent {
  return {
    disposedAt: 1735689600, // 2025-01-01T00:00:00Z
    acquiredAt: 1704067200, // 2024-01-01T00:00:00Z
    holdingPeriodDays: 365,
    term: "long",
    eventType: "sale",
    asset: "ETH",
    assetFamily: "ETH",
    amount: 1,
    proceedsUsd: 3000,
    costBasisUsd: 2000,
    gainUsd: 1000,
    txHash: "0xabc",
    chain: "eth",
    sourceHash: "0xdef",
    walletId: "w1",
    ...args,
  };
}

describe("exportTaxEventsToCsv — Tax T2", () => {
  it("empty events → header only", () => {
    const csv = exportTaxEventsToCsv([]);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("date_iso");
    expect(lines[0]).toContain("event_type");
    expect(lines[0]).toContain("gain_usd");
  });

  it("единичный event → header + row", () => {
    const csv = exportTaxEventsToCsv([ev({})]);
    const lines = csv.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("sale");
    expect(lines[1]).toContain("ETH");
    expect(lines[1]).toContain("1000"); // gain
  });

  it("числовая precision: USD = 2 decimals, amount = 8", () => {
    const csv = exportTaxEventsToCsv([
      ev({
        amount: 0.123456789,
        proceedsUsd: 3000.567,
        costBasisUsd: 2000.999,
      }),
    ]);
    expect(csv).toContain("0.12345679"); // 8 decimals rounded
    expect(csv).toContain("3000.57");
    expect(csv).toContain("2001.00");
  });

  it("ISO дата UTC", () => {
    const csv = exportTaxEventsToCsv([
      ev({ disposedAt: 1704067200, acquiredAt: 1672531200 }),
    ]);
    expect(csv).toContain("2024-01-01T00:00:00.000Z");
    expect(csv).toContain("2023-01-01T00:00:00.000Z");
  });

  it("RFC 4180: запятая в поле → quoted", () => {
    const csv = exportTaxEventsToCsv([
      ev({ asset: "ETH,WEIRD" }), // exotic asset with comma
    ]);
    expect(csv).toMatch(/"ETH,WEIRD"/);
  });

  it("RFC 4180: кавычка в поле → escape двойной кавычкой", () => {
    const csv = exportTaxEventsToCsv([
      ev({ asset: 'WEIRD"NAME' }),
    ]);
    expect(csv).toMatch(/"WEIRD""NAME"/);
  });

  it("term значения short / long корректно сериализуются", () => {
    const csv = exportTaxEventsToCsv([
      ev({ term: "short", holdingPeriodDays: 30 }),
      ev({ term: "long", holdingPeriodDays: 400 }),
    ]);
    expect(csv).toContain("short");
    expect(csv).toContain("long");
    expect(csv).toContain("30");
    expect(csv).toContain("400");
  });

  it("multiple events sorted by disposedAt (preserved input order)", () => {
    const e1 = ev({ disposedAt: 1000, txHash: "0xfirst" });
    const e2 = ev({ disposedAt: 2000, txHash: "0xsecond" });
    const csv = exportTaxEventsToCsv([e1, e2]);
    const lines = csv.split("\n");
    expect(lines[1]).toContain("0xfirst");
    expect(lines[2]).toContain("0xsecond");
  });

  it("loss case: negative gain корректно", () => {
    const csv = exportTaxEventsToCsv([
      ev({ gainUsd: -500, costBasisUsd: 2500, proceedsUsd: 2000 }),
    ]);
    expect(csv).toContain("-500.00");
  });

  it("aggregate totals via separate helper", () => {
    const events = [
      ev({ gainUsd: 1000, term: "short" }),
      ev({ gainUsd: -200, term: "short" }),
      ev({ gainUsd: 500, term: "long" }),
    ];
    const csv = exportTaxEventsToCsv(events);
    // Each event present
    expect(csv.split("\n").filter((l) => l.length > 0)).toHaveLength(4); // header + 3
  });
});
