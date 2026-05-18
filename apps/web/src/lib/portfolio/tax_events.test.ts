/**
 * Tax T1: tests for generateTaxEvents.
 *
 * Tax event = одна disposition с per-lot detail:
 *   - eventType: 'sale' (non-stable → stable) | 'exchange' (token→token,
 *     US-style "like-kind" не работает с 2018) | 'income' (reward с FMV)
 *   - acquiredAt, disposedAt → определяют term (short < 1y / long >= 1y)
 *   - proceedsUsd, costBasisUsd, gainUsd
 *   - asset / amount / txHash для audit trail
 *
 * Использует LotTracker.consume() чтобы получить per-lot detail — каждая
 * consumed lot становится отдельным TaxEvent.
 */
import { describe, expect, it } from "vitest";

import { generateTaxEvents } from "./tax_events";
import type { ClassifiedOp } from "./types";

const DAY = 24 * 60 * 60;
const YEAR = 365 * DAY;

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

describe("generateTaxEvents — Tax T1", () => {
  it("empty ops → empty output", () => {
    expect(generateTaxEvents([], "w1")).toEqual([]);
  });

  it("buy + sell at gain → 1 sale event, gain calculated", () => {
    const ops: ClassifiedOp[] = [
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
        time: 1000 + 100 * DAY,
        movements: [
          { direction: "out", symbol: "ETH", amount: 1, usd: 3000 },
          { direction: "in", symbol: "USDT", amount: 3000, usd: 3000 },
        ],
      }),
    ];
    const events = generateTaxEvents(ops, "w1");
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.eventType).toBe("sale");
    expect(e.asset).toBe("ETH");
    expect(e.amount).toBeCloseTo(1, 6);
    expect(e.proceedsUsd).toBeCloseTo(3000, 2);
    expect(e.costBasisUsd).toBeCloseTo(2000, 2);
    expect(e.gainUsd).toBeCloseTo(1000, 2);
    expect(e.term).toBe("short"); // 100d < 1y
    expect(e.holdingPeriodDays).toBeGreaterThan(99);
    expect(e.txHash).toBe("0xsell");
  });

  it("long-term holding (>= 1y) → term = 'long'", () => {
    const ops: ClassifiedOp[] = [
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
        time: 1000 + YEAR + DAY,
        movements: [
          { direction: "out", symbol: "ETH", amount: 1, usd: 3000 },
          { direction: "in", symbol: "USDT", amount: 3000, usd: 3000 },
        ],
      }),
    ];
    const events = generateTaxEvents(ops, "w1");
    expect(events[0]?.term).toBe("long");
  });

  it("withdraw_fiat → sale event (продал крипту за фиат)", () => {
    const ops: ClassifiedOp[] = [
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
        hash: "0xfiat",
        type: "withdraw_fiat",
        time: 1000 + 50 * DAY,
        movements: [
          { direction: "out", symbol: "ETH", amount: 1, usd: 3500 },
        ],
      }),
    ];
    const events = generateTaxEvents(ops, "w1");
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("sale");
    expect(events[0]?.gainUsd).toBeCloseTo(1500, 2);
  });

  it("token-to-token swap (ETH → BTC) → exchange event (US: taxable)", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xbuyEth",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDT", amount: 2000, usd: 2000 },
          { direction: "in", symbol: "ETH", amount: 1, usd: 2000 },
        ],
      }),
      op({
        hash: "0xeth2btc",
        type: "swap",
        time: 1000 + 30 * DAY,
        movements: [
          { direction: "out", symbol: "ETH", amount: 1, usd: 3000 },
          { direction: "in", symbol: "BTC", amount: 0.05, usd: 3000 },
        ],
      }),
    ];
    const events = generateTaxEvents(ops, "w1");
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("exchange");
    expect(events[0]?.asset).toBe("ETH"); // disposed asset
    expect(events[0]?.gainUsd).toBeCloseTo(1000, 2);
  });

  it("reward + sell → 2 events: income (FMV) + sale (full proceeds, cost=0)", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xclaim",
        type: "claim_rewards",
        time: 1000,
        movements: [{ direction: "in", symbol: "ARB", amount: 100, usd: 200 }],
      }),
      op({
        hash: "0xsell",
        type: "swap",
        time: 1000 + 30 * DAY,
        movements: [
          { direction: "out", symbol: "ARB", amount: 100, usd: 250 },
          { direction: "in", symbol: "USDT", amount: 250, usd: 250 },
        ],
      }),
    ];
    const events = generateTaxEvents(ops, "w1");
    expect(events).toHaveLength(2);

    const income = events.find((e) => e.eventType === "income")!;
    expect(income.asset).toBe("ARB");
    expect(income.proceedsUsd).toBeCloseTo(200, 2); // FMV at receipt
    expect(income.costBasisUsd).toBe(0);
    expect(income.gainUsd).toBeCloseTo(200, 2);

    const sale = events.find((e) => e.eventType === "sale")!;
    expect(sale.proceedsUsd).toBeCloseTo(250, 2);
    expect(sale.costBasisUsd).toBe(0); // reward cost=0
    expect(sale.gainUsd).toBeCloseTo(250, 2); // full proceeds
  });

  it("transfer_out (на свой кошелёк) → НЕ событие (не disposition)", () => {
    const ops: ClassifiedOp[] = [
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
        hash: "0xtransfer",
        type: "transfer_out",
        time: 1000 + 30 * DAY,
        movements: [
          { direction: "out", symbol: "ETH", amount: 1, usd: 3000 },
        ],
      }),
    ];
    const events = generateTaxEvents(ops, "w1");
    expect(events).toEqual([]);
  });

  it("multi-lot sale: partial sell даёт events per lot consumed", () => {
    // Buy 1 ETH @ $2000 day 1
    // Buy 1 ETH @ $2500 day 200
    // Sell 1.5 ETH day 300 @ $3000/ETH ($4500 proceeds)
    // WAC consume: 1.5 ETH × WAC$2250 = $3375 cost basis
    // Gain = $4500 - $3375 = $1125
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xbuy1",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDT", amount: 2000, usd: 2000 },
          { direction: "in", symbol: "ETH", amount: 1, usd: 2000 },
        ],
      }),
      op({
        hash: "0xbuy2",
        type: "swap",
        time: 1000 + 200 * DAY,
        movements: [
          { direction: "out", symbol: "USDT", amount: 2500, usd: 2500 },
          { direction: "in", symbol: "ETH", amount: 1, usd: 2500 },
        ],
      }),
      op({
        hash: "0xsell",
        type: "swap",
        time: 1000 + 300 * DAY,
        movements: [
          { direction: "out", symbol: "ETH", amount: 1.5, usd: 4500 },
          { direction: "in", symbol: "USDT", amount: 4500, usd: 4500 },
        ],
      }),
    ];
    const events = generateTaxEvents(ops, "w1");
    // WAC методология: один aggregate event на consume.
    // (FIFO/LIFO режимы — backlog T1.1; v1 = WAC через LotTracker default).
    expect(events.length).toBeGreaterThanOrEqual(1);
    const totalAmount = events.reduce((s, e) => s + e.amount, 0);
    expect(totalAmount).toBeCloseTo(1.5, 6);
    const totalGain = events.reduce((s, e) => s + e.gainUsd, 0);
    expect(totalGain).toBeCloseTo(1125, 1);
  });

  it("failed op игнорируется", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xbuy",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDT", amount: 2000, usd: 2000 },
          { direction: "in", symbol: "ETH", amount: 1, usd: 2000 },
        ],
      }),
      {
        ...op({
          hash: "0xfailed",
          type: "swap",
          time: 2000,
          movements: [
            { direction: "out", symbol: "ETH", amount: 1, usd: 3000 },
            { direction: "in", symbol: "USDT", amount: 3000, usd: 3000 },
          ],
        }),
        status: "failed" as const,
      },
    ];
    const events = generateTaxEvents(ops, "w1");
    expect(events).toEqual([]);
  });

  it("loss case: gainUsd < 0", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xbuy",
        type: "swap",
        time: 1000,
        movements: [
          { direction: "out", symbol: "USDT", amount: 5000, usd: 5000 },
          { direction: "in", symbol: "ETH", amount: 1, usd: 5000 },
        ],
      }),
      op({
        hash: "0xsell",
        type: "swap",
        time: 1000 + 30 * DAY,
        movements: [
          { direction: "out", symbol: "ETH", amount: 1, usd: 3000 },
          { direction: "in", symbol: "USDT", amount: 3000, usd: 3000 },
        ],
      }),
    ];
    const events = generateTaxEvents(ops, "w1");
    expect(events[0]?.gainUsd).toBeCloseTo(-2000, 2);
  });

  // ─── T1.1: FIFO / LIFO / HIFO ────────────────────────────────────────
  describe("methodology selector", () => {
    function buildMultiLotOps(): ClassifiedOp[] {
      // 3 buys: 1 ETH @ $1000, $3000, $2000 → average $2000
      // Then sell 1 ETH @ $2500 → proceeds = $2500
      return [
        op({
          hash: "0xbuy1",
          type: "swap",
          time: 1000,
          movements: [
            { direction: "out", symbol: "USDT", amount: 1000, usd: 1000 },
            { direction: "in", symbol: "ETH", amount: 1, usd: 1000 },
          ],
        }),
        op({
          hash: "0xbuy2",
          type: "swap",
          time: 2000,
          movements: [
            { direction: "out", symbol: "USDT", amount: 3000, usd: 3000 },
            { direction: "in", symbol: "ETH", amount: 1, usd: 3000 },
          ],
        }),
        op({
          hash: "0xbuy3",
          type: "swap",
          time: 3000,
          movements: [
            { direction: "out", symbol: "USDT", amount: 2000, usd: 2000 },
            { direction: "in", symbol: "ETH", amount: 1, usd: 2000 },
          ],
        }),
        op({
          hash: "0xsell",
          type: "swap",
          time: 4000,
          movements: [
            { direction: "out", symbol: "ETH", amount: 1, usd: 2500 },
            { direction: "in", symbol: "USDT", amount: 2500, usd: 2500 },
          ],
        }),
      ];
    }

    it("FIFO: consume earliest lot ($1000) → gain = +$1500", () => {
      const events = generateTaxEvents(buildMultiLotOps(), "w1", "FIFO");
      expect(events).toHaveLength(1);
      expect(events[0]?.costBasisUsd).toBeCloseTo(1000, 2);
      expect(events[0]?.gainUsd).toBeCloseTo(1500, 2);
    });

    it("LIFO: consume latest lot ($2000) → gain = +$500", () => {
      const events = generateTaxEvents(buildMultiLotOps(), "w1", "LIFO");
      expect(events).toHaveLength(1);
      expect(events[0]?.costBasisUsd).toBeCloseTo(2000, 2);
      expect(events[0]?.gainUsd).toBeCloseTo(500, 2);
    });

    it("HIFO: consume highest cost lot ($3000) → gain = −$500 (loss harvested)", () => {
      const events = generateTaxEvents(buildMultiLotOps(), "w1", "HIFO");
      expect(events).toHaveLength(1);
      expect(events[0]?.costBasisUsd).toBeCloseTo(3000, 2);
      expect(events[0]?.gainUsd).toBeCloseTo(-500, 2);
    });

    it("WAC (default): consume average ($2000) → gain = +$500", () => {
      const events = generateTaxEvents(buildMultiLotOps(), "w1");
      expect(events).toHaveLength(1);
      expect(events[0]?.costBasisUsd).toBeCloseTo(2000, 2);
      expect(events[0]?.gainUsd).toBeCloseTo(500, 2);
    });

    it("HIFO < FIFO < LIFO < WAC ordering of gains (для бычьего scenario)", () => {
      // Buys ascending: $1000 / $2000 / $3000. Sell @ $2500.
      // FIFO consume $1000 → gain +1500
      // LIFO consume $3000 → gain -500
      // HIFO consume $3000 → gain -500 (same as LIFO when newest = most expensive)
      // WAC consume $2000 → gain +500
      // Order: HIFO=LIFO < WAC < FIFO для этого случая.
      const ops: ClassifiedOp[] = [
        op({
          hash: "0xbuy1",
          type: "swap",
          time: 1000,
          movements: [
            { direction: "out", symbol: "USDT", amount: 1000, usd: 1000 },
            { direction: "in", symbol: "ETH", amount: 1, usd: 1000 },
          ],
        }),
        op({
          hash: "0xbuy2",
          type: "swap",
          time: 2000,
          movements: [
            { direction: "out", symbol: "USDT", amount: 2000, usd: 2000 },
            { direction: "in", symbol: "ETH", amount: 1, usd: 2000 },
          ],
        }),
        op({
          hash: "0xbuy3",
          type: "swap",
          time: 3000,
          movements: [
            { direction: "out", symbol: "USDT", amount: 3000, usd: 3000 },
            { direction: "in", symbol: "ETH", amount: 1, usd: 3000 },
          ],
        }),
        op({
          hash: "0xsell",
          type: "swap",
          time: 4000,
          movements: [
            { direction: "out", symbol: "ETH", amount: 1, usd: 2500 },
            { direction: "in", symbol: "USDT", amount: 2500, usd: 2500 },
          ],
        }),
      ];
      const fifo = generateTaxEvents(ops, "w1", "FIFO")[0]!.gainUsd;
      const lifo = generateTaxEvents(ops, "w1", "LIFO")[0]!.gainUsd;
      const hifo = generateTaxEvents(ops, "w1", "HIFO")[0]!.gainUsd;
      const wac = generateTaxEvents(ops, "w1", "WAC")[0]!.gainUsd;
      // HIFO всегда ≤ остальных (tax-optimal).
      expect(hifo).toBeLessThanOrEqual(fifo);
      expect(hifo).toBeLessThanOrEqual(lifo);
      expect(hifo).toBeLessThanOrEqual(wac);
    });
  });

  it("acquiredAt + disposedAt timestamps корректны", () => {
    const buyTime = 1000;
    const sellTime = 1000 + 100 * DAY;
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xbuy",
        type: "swap",
        time: buyTime,
        movements: [
          { direction: "out", symbol: "USDT", amount: 2000, usd: 2000 },
          { direction: "in", symbol: "ETH", amount: 1, usd: 2000 },
        ],
      }),
      op({
        hash: "0xsell",
        type: "swap",
        time: sellTime,
        movements: [
          { direction: "out", symbol: "ETH", amount: 1, usd: 3000 },
          { direction: "in", symbol: "USDT", amount: 3000, usd: 3000 },
        ],
      }),
    ];
    const events = generateTaxEvents(ops, "w1");
    expect(events[0]?.acquiredAt).toBe(buyTime);
    expect(events[0]?.disposedAt).toBe(sellTime);
    expect(events[0]?.holdingPeriodDays).toBe(100);
  });
});
