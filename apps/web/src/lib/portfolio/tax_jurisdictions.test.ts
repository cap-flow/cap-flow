/**
 * Tax T5: tests for jurisdiction-aware tax event generation.
 *
 * Different countries different rules:
 *   - Long-term holding threshold (US: 365d, RU: 3y, UK: no distinction)
 *   - Allowed methodologies (US flexible, RU FIFO/LIFO, UK avg cost only)
 *   - Token-to-token taxable (US/EU yes, some others no)
 *
 * Disclaimer: simplifications. Real tax law way more nuanced.
 */
import { describe, expect, it } from "vitest";

import {
  JURISDICTIONS,
  getJurisdictionConfig,
  type Jurisdiction,
} from "./tax_jurisdictions";
import { generateTaxEvents } from "./tax_events";
import type { ClassifiedOp } from "./types";

const DAY = 24 * 60 * 60;

function op(args: {
  hash: string;
  type: string;
  time: number;
  movements: Array<{
    direction: "in" | "out";
    symbol: string;
    amount: number;
    usd?: number;
  }>;
}): ClassifiedOp {
  return {
    hash: args.hash,
    type: args.type as never,
    time: args.time,
    chain: "eth",
    status: "success",
    movement: args.movements.map((m) => ({
      direction: m.direction,
      symbol: m.symbol,
      amount: m.amount,
      usd: m.usd ?? 0,
      tokenId: m.symbol.toLowerCase(),
      isStable: ["USDT", "USDC", "DAI"].includes(m.symbol.toUpperCase()),
    })),
    fnName: "",
    cateId: "",
    counter: "",
    counterName: "",
    project: null,
    protocol: null,
    fees: { gasUsd: 0, otherUsd: 0 },
    notes: [],
    seq: 0,
    isInternal: false,
    counterAddresses: [],
    netUsd: 0,
    gasUsd: 0,
  } as ClassifiedOp;
}

describe("tax_jurisdictions config", () => {
  it("4 jurisdictions defined", () => {
    expect(JURISDICTIONS).toEqual(["US", "EU", "RU", "UK"]);
  });

  it("US: long-term ≥ 365d, all methodologies, token-to-token taxable", () => {
    const c = getJurisdictionConfig("US");
    expect(c.longTermThresholdDays).toBe(365);
    expect(c.allowedMethodologies).toContain("WAC");
    expect(c.allowedMethodologies).toContain("FIFO");
    expect(c.allowedMethodologies).toContain("LIFO");
    expect(c.allowedMethodologies).toContain("HIFO");
    expect(c.tokenToTokenTaxable).toBe(true);
  });

  it("RU: long-term ≥ 1095d (3 years), FIFO/LIFO only", () => {
    const c = getJurisdictionConfig("RU");
    expect(c.longTermThresholdDays).toBe(1095);
    expect(c.allowedMethodologies).toEqual(["FIFO", "LIFO"]);
  });

  it("UK: no long-term distinction (threshold = Infinity)", () => {
    const c = getJurisdictionConfig("UK");
    expect(c.longTermThresholdDays).toBe(Number.POSITIVE_INFINITY);
    // UK section 104 pooling = WAC.
    expect(c.allowedMethodologies).toEqual(["WAC"]);
  });

  it("EU: 365d threshold, WAC/FIFO", () => {
    const c = getJurisdictionConfig("EU");
    expect(c.longTermThresholdDays).toBe(365);
    expect(c.allowedMethodologies).toContain("FIFO");
  });
});

describe("generateTaxEvents with jurisdiction", () => {
  function buildBuySellOps(daysHeld: number): ClassifiedOp[] {
    return [
      op({
        hash: "0xbuy",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDT", amount: 2000, usd: 2000 },
          { direction: "in", symbol: "ETH", amount: 1, usd: 2000 },
        ],
      }),
      op({
        hash: "0xsell",
        type: "swap",
        time: 1000 + daysHeld * DAY,
        movements: [
          { direction: "out", symbol: "ETH", amount: 1, usd: 3000 },
          { direction: "in", symbol: "USDT", amount: 3000, usd: 3000 },
        ],
      }),
    ];
  }

  it("US: 400 days held → 'long'", () => {
    const events = generateTaxEvents(buildBuySellOps(400), "w1", "WAC", "US");
    expect(events[0]?.term).toBe("long");
  });

  it("RU: 400 days held → 'short' (RU threshold = 1095 days)", () => {
    const events = generateTaxEvents(buildBuySellOps(400), "w1", "WAC", "RU");
    expect(events[0]?.term).toBe("short");
  });

  it("RU: 1100 days held → 'long'", () => {
    const events = generateTaxEvents(buildBuySellOps(1100), "w1", "WAC", "RU");
    expect(events[0]?.term).toBe("long");
  });

  it("UK: ANY holding → 'short' (no long-term distinction)", () => {
    const events = generateTaxEvents(buildBuySellOps(5000), "w1", "WAC", "UK");
    expect(events[0]?.term).toBe("short");
  });

  it("EU: 400 days → 'long'", () => {
    const events = generateTaxEvents(buildBuySellOps(400), "w1", "WAC", "EU");
    expect(events[0]?.term).toBe("long");
  });

  it("default (no jurisdiction) — backward compat US behavior", () => {
    const events = generateTaxEvents(buildBuySellOps(400), "w1", "WAC");
    expect(events[0]?.term).toBe("long"); // US-default 365d
  });
});

describe("token-to-token taxable per jurisdiction", () => {
  function tokenToTokenSwap(): ClassifiedOp[] {
    return [
      op({
        hash: "0xbuy",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDT", amount: 2000, usd: 2000 },
          { direction: "in", symbol: "ETH", amount: 1, usd: 2000 },
        ],
      }),
      op({
        hash: "0xswap",
        type: "swap",
        time: 1000 + 30 * DAY,
        movements: [
          { direction: "out", symbol: "ETH", amount: 1, usd: 3000 },
          { direction: "in", symbol: "BTC", amount: 0.05, usd: 3000 },
        ],
      }),
    ];
  }

  it("US: token-to-token swap → exchange event", () => {
    const events = generateTaxEvents(tokenToTokenSwap(), "w1", "WAC", "US");
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("exchange");
  });

  // Note: для v1 все jurisdictions считают token-to-token taxable.
  // Будущие jurisdictions с like-kind exception → backlog T5.1.
});
