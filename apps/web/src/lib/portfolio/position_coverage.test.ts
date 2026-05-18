/**
 * Tests for position_coverage aggregator.
 *
 * Доменная задача: для on-chain позиции (например POS-007 Aave V3 WBTC)
 * показать какая часть amount покрыта известным cost basis из 3 источников:
 *
 *  1. **Direct buy on-chain** — `affectsWac=true` ивенты из purchase_history
 *     (swap_from_stable / swap_from_token / fiat_buy).
 *  2. **CEX inheritance** — `transfer_in` ивент, у которого tx-hash совпадает
 *     с CEX withdrawal (cost basis вытащен на бирже из P2P→trade пула).
 *  3. **LP unwind inheritance** — `lp_close_attribution` ивент, унаследованный
 *     cost basis от lp_add через cost_basis_tracker.
 *
 * Остальное (`transfer_in` без match'а в CEX map, например внутренние
 * переводы между нашими же кошельками без CEX-следа) → `unknown`.
 *
 * Тесты строим на factory `ev()` чтобы не таскать все поля PurchaseEvent.
 */
import { describe, expect, it } from "vitest";

import type { PurchaseEvent } from "./purchase_history";
import {
  computePositionCoverage,
  enrichPurchaseEventsForCoverage,
  type CexCostBasisMatch,
} from "./position_coverage";

function ev(
  p: Partial<PurchaseEvent> & Pick<PurchaseEvent, "kind" | "amount" | "hash">,
): PurchaseEvent {
  // Default `affectsWac` по тому же правилу что и purchase_history.ts:
  // только "swap_from_stable" / "swap_from_token" / "fiat_buy" дают WAC.
  const defaultAffectsWac =
    p.kind === "swap_from_stable" ||
    p.kind === "swap_from_token" ||
    p.kind === "fiat_buy";
  return {
    time: 1700000000,
    costUsd: 0,
    pricePerUnit: 0,
    affectsWac: defaultAffectsWac,
    chain: "eth",
    ...p,
  };
}

function mapOf(
  ...entries: Array<[string, number, string, string?]>
): Map<string, CexCostBasisMatch> {
  // Tuple form: [hash, costBasisUsd, asset, source?]
  const m = new Map<string, CexCostBasisMatch>();
  for (const [hash, costBasisUsd, asset, source = "fiat-direct"] of entries) {
    m.set(hash.toLowerCase(), { costBasisUsd, source, asset });
  }
  return m;
}

describe("computePositionCoverage — empty / degenerate", () => {
  it("no events at all → 0% coverage, 0 USD", () => {
    const r = computePositionCoverage({
      totalAmount: 10,
      events: [],
      cexCostBasisByHash: new Map(),
      targetSymbol: "WBTC",
    });
    expect(r.totalAmount).toBe(10);
    expect(r.coveredAmount).toBe(0);
    expect(r.coveredUsd).toBe(0);
    expect(r.coveragePct).toBe(0);
    expect(r.wac).toBe(0);
    expect(r.directBuy.amount).toBe(0);
    expect(r.cexInheritance.amount).toBe(0);
    expect(r.lpUnwind.amount).toBe(0);
    expect(r.unknown.amount).toBe(0);
  });

  it("totalAmount = 0 → coveragePct = 0 (no division by zero)", () => {
    const r = computePositionCoverage({
      totalAmount: 0,
      events: [ev({ kind: "swap_from_stable", amount: 1, hash: "0xa", costUsd: 100 })],
      cexCostBasisByHash: new Map(),
      targetSymbol: "WBTC",
    });
    expect(r.coveragePct).toBe(0);
    // Но covered* должны быть нормальные:
    expect(r.directBuy.amount).toBe(1);
    expect(r.directBuy.usd).toBe(100);
  });
});

describe("computePositionCoverage — direct buys", () => {
  it("single direct buy → directBuy filled, others zero", () => {
    const r = computePositionCoverage({
      totalAmount: 10,
      events: [
        ev({ kind: "swap_from_stable", amount: 4, hash: "0xa", costUsd: 200 }),
      ],
      cexCostBasisByHash: new Map(),
      targetSymbol: "WBTC",
    });
    expect(r.directBuy.amount).toBe(4);
    expect(r.directBuy.usd).toBe(200);
    expect(r.directBuy.count).toBe(1);
    expect(r.coveredAmount).toBe(4);
    expect(r.coveredUsd).toBe(200);
    expect(r.coveragePct).toBeCloseTo(40, 6);
    expect(r.wac).toBeCloseTo(50, 6);
  });

  it("multiple direct buys aggregated", () => {
    const r = computePositionCoverage({
      totalAmount: 10,
      events: [
        ev({ kind: "swap_from_stable", amount: 3, hash: "0xa", costUsd: 90 }),
        ev({ kind: "swap_from_token", amount: 2, hash: "0xb", costUsd: 80 }),
        ev({ kind: "fiat_buy", amount: 1, hash: "0xc", costUsd: 40 }),
      ],
      cexCostBasisByHash: new Map(),
      targetSymbol: "WBTC",
    });
    expect(r.directBuy.amount).toBe(6);
    expect(r.directBuy.usd).toBe(210);
    expect(r.directBuy.count).toBe(3);
    expect(r.coveredAmount).toBe(6);
    expect(r.coveragePct).toBeCloseTo(60, 6);
    expect(r.wac).toBeCloseTo(35, 6);
  });

  it("sells / transfer_out / deploy не считаются покрытием", () => {
    const r = computePositionCoverage({
      totalAmount: 10,
      events: [
        // direct buy
        ev({ kind: "swap_from_stable", amount: 2, hash: "0xa", costUsd: 100 }),
        // sells / outflows — НЕ покрытие, амount там отрицательный
        ev({ kind: "sell_to_stable", amount: -1, hash: "0xb", costUsd: 50 }),
        ev({ kind: "transfer_out", amount: -0.5, hash: "0xc", costUsd: 25 }),
        ev({ kind: "deploy", amount: -1, hash: "0xd", costUsd: 50 }),
      ],
      cexCostBasisByHash: new Map(),
      targetSymbol: "WBTC",
    });
    expect(r.directBuy.amount).toBe(2);
    expect(r.directBuy.usd).toBe(100);
    expect(r.coveredAmount).toBe(2);
  });
});

describe("computePositionCoverage — CEX inheritance", () => {
  it("transfer_in matched by tx-hash → cexInheritance picks up costUsd", () => {
    const r = computePositionCoverage({
      totalAmount: 10,
      events: [
        ev({ kind: "transfer_in", amount: 6, hash: "0xWITHDRAW1" }),
      ],
      cexCostBasisByHash: mapOf(["0xwithdraw1", 300, "WBTC"]),
      targetSymbol: "WBTC",
    });
    expect(r.cexInheritance.amount).toBe(6);
    expect(r.cexInheritance.usd).toBe(300);
    expect(r.cexInheritance.matchedHashes).toEqual(["0xwithdraw1"]);
    expect(r.unknown.amount).toBe(0);
    expect(r.coveredAmount).toBe(6);
    expect(r.coveragePct).toBeCloseTo(60, 6);
  });

  it("hash match case-insensitive (mixed-case events vs lowercase map)", () => {
    const r = computePositionCoverage({
      totalAmount: 5,
      events: [ev({ kind: "transfer_in", amount: 5, hash: "0xAbCdEf" })],
      cexCostBasisByHash: mapOf(["0xabcdef", 250, "WBTC"]),
      targetSymbol: "WBTC",
    });
    expect(r.cexInheritance.amount).toBe(5);
    expect(r.cexInheritance.usd).toBe(250);
  });

  it("transfer_in without CEX match → unknown bucket", () => {
    const r = computePositionCoverage({
      totalAmount: 10,
      events: [ev({ kind: "transfer_in", amount: 4, hash: "0xNOMATCH" })],
      cexCostBasisByHash: new Map(),
      targetSymbol: "WBTC",
    });
    expect(r.cexInheritance.amount).toBe(0);
    expect(r.unknown.amount).toBe(4);
    expect(r.unknown.count).toBe(1);
    expect(r.coveredAmount).toBe(0);
  });

  it("CEX match для другого asset (USDC withdrawal на WBTC позицию) → unknown", () => {
    // Защита от ложных matches: если withdrawal asset не совпадает с
    // target symbol (например на этот hash CEX отдал USDC, а в позицию пришёл
    // WBTC через сложный bridge tx), не атрибутируем.
    const r = computePositionCoverage({
      totalAmount: 10,
      events: [ev({ kind: "transfer_in", amount: 4, hash: "0xWITHDRAW" })],
      cexCostBasisByHash: mapOf(["0xwithdraw", 500, "USDC"]),
      targetSymbol: "WBTC",
    });
    expect(r.cexInheritance.amount).toBe(0);
    expect(r.unknown.amount).toBe(4);
  });

  it("WETH ↔ ETH normalization: CEX отдала ETH, позиция держит WETH", () => {
    // CEX withdrawal asset = ETH, позиция = WETH. Должно match.
    const r = computePositionCoverage({
      totalAmount: 10,
      events: [ev({ kind: "transfer_in", amount: 5, hash: "0xeth" })],
      cexCostBasisByHash: mapOf(["0xeth", 12500, "ETH"]),
      targetSymbol: "WETH",
    });
    expect(r.cexInheritance.amount).toBe(5);
    expect(r.cexInheritance.usd).toBe(12500);
  });

  it("CEX match с costBasisUsd=0 (source=unknown) → НЕ считается покрытием", () => {
    // У биржи нет фиатной точки опоры → не атрибутируем cost,
    // но amount остаётся в unknown bucket.
    const r = computePositionCoverage({
      totalAmount: 10,
      events: [ev({ kind: "transfer_in", amount: 4, hash: "0xnocost" })],
      cexCostBasisByHash: mapOf(["0xnocost", 0, "WBTC", "unknown"]),
      targetSymbol: "WBTC",
    });
    expect(r.cexInheritance.amount).toBe(0);
    expect(r.unknown.amount).toBe(4);
  });
});

describe("computePositionCoverage — LP unwind", () => {
  it("lp_close_attribution → lpUnwind picks up cost", () => {
    const r = computePositionCoverage({
      totalAmount: 10,
      events: [
        ev({
          kind: "lp_close_attribution",
          amount: 3,
          hash: "0xlp",
          costUsd: 150,
        }),
      ],
      cexCostBasisByHash: new Map(),
      targetSymbol: "WBTC",
    });
    expect(r.lpUnwind.amount).toBe(3);
    expect(r.lpUnwind.usd).toBe(150);
    expect(r.lpUnwind.count).toBe(1);
    expect(r.coveredAmount).toBe(3);
    expect(r.coveragePct).toBeCloseTo(30, 6);
  });

  it("lp_close_attribution с costUsd=0 (tracker не знает WAC) → НЕ покрытие", () => {
    const r = computePositionCoverage({
      totalAmount: 10,
      events: [
        ev({
          kind: "lp_close_attribution",
          amount: 3,
          hash: "0xlp",
          costUsd: 0,
        }),
      ],
      cexCostBasisByHash: new Map(),
      targetSymbol: "WBTC",
    });
    expect(r.lpUnwind.amount).toBe(0);
    expect(r.coveredAmount).toBe(0);
  });
});

describe("computePositionCoverage — все три источника комбинированы (POS-007 сценарий)", () => {
  it("3.2% direct + большая доля cex + чуть-чуть lp + остаток unknown", () => {
    // Имитируем реальный сценарий POS-007:
    //   total = 0.176625 WBTC
    //   direct buy = 0.005647 (3.2%)
    //   transfer_in от bingx = 0.150 (matched)
    //   lp_remove = 0.010 (с inherited cost)
    //   transfer_in без CEX-следа = 0.010978 (unknown)
    const r = computePositionCoverage({
      totalAmount: 0.176625,
      events: [
        ev({ kind: "swap_from_stable", amount: 0.005647, hash: "0xbuy", costUsd: 350 }),
        ev({ kind: "transfer_in", amount: 0.15, hash: "0xbingx" }),
        ev({ kind: "lp_close_attribution", amount: 0.01, hash: "0xlp", costUsd: 620 }),
        ev({ kind: "transfer_in", amount: 0.010978, hash: "0xinternal" }),
      ],
      cexCostBasisByHash: mapOf(["0xbingx", 9200, "WBTC"]),
      targetSymbol: "WBTC",
    });
    expect(r.directBuy.amount).toBeCloseTo(0.005647, 6);
    expect(r.directBuy.usd).toBe(350);
    expect(r.cexInheritance.amount).toBeCloseTo(0.15, 6);
    expect(r.cexInheritance.usd).toBe(9200);
    expect(r.lpUnwind.amount).toBeCloseTo(0.01, 6);
    expect(r.lpUnwind.usd).toBe(620);
    expect(r.unknown.amount).toBeCloseTo(0.010978, 6);

    const expectedCovered = 0.005647 + 0.15 + 0.01;
    const expectedUsd = 350 + 9200 + 620;
    expect(r.coveredAmount).toBeCloseTo(expectedCovered, 6);
    expect(r.coveredUsd).toBe(expectedUsd);
    expect(r.coveragePct).toBeCloseTo((expectedCovered / 0.176625) * 100, 4);
    expect(r.wac).toBeCloseTo(expectedUsd / expectedCovered, 4);
  });
});

describe("computePositionCoverage — coverage clamping", () => {
  it("над-покрытие (купили больше чем держим) → clamp 100%", () => {
    // Сценарий: 5 WBTC куплено, но 3 уже продано → totalAmount = 2.
    // Аггрегатор НЕ вычитает sells (это будет другой слой);
    // здесь покрытие clamp'ится на 100% чтобы не возвращать > 100.
    const r = computePositionCoverage({
      totalAmount: 2,
      events: [
        ev({ kind: "swap_from_stable", amount: 5, hash: "0xa", costUsd: 250 }),
      ],
      cexCostBasisByHash: new Map(),
      targetSymbol: "WBTC",
    });
    expect(r.directBuy.amount).toBe(5);
    expect(r.coveragePct).toBe(100);
  });
});

/* ─── enrichPurchaseEventsForCoverage ─── */

describe("enrichPurchaseEventsForCoverage — фильтрация и обогащение", () => {
  it("direct buy events возвращаются как costSource='direct'", () => {
    const out = enrichPurchaseEventsForCoverage(
      [
        ev({ kind: "swap_from_stable", amount: 2, hash: "0xa", costUsd: 100 }),
        ev({ kind: "fiat_buy", amount: 1, hash: "0xb", costUsd: 40 }),
      ],
      new Map(),
      "WBTC",
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.costSource).toBe("direct");
    expect(out[1]!.costSource).toBe("direct");
    // costUsd сохраняется как был
    expect(out[0]!.costUsd).toBe(100);
  });

  it("transfer_in matched в CEX-map → costSource='cex', costUsd подменён", () => {
    const out = enrichPurchaseEventsForCoverage(
      [ev({ kind: "transfer_in", amount: 0.1, hash: "0xCEX", costUsd: 0 })],
      mapOf(["0xcex", 6000, "WBTC", "fiat-direct"]),
      "WBTC",
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.costSource).toBe("cex");
    expect(out[0]!.costUsd).toBe(6000);
    expect(out[0]!.pricePerUnit).toBeCloseTo(60000, 2);
    expect(out[0]!.inheritanceSource).toBe("fiat-direct");
  });

  it("transfer_in без CEX-следа → отбрасывается (не покрытие)", () => {
    const out = enrichPurchaseEventsForCoverage(
      [ev({ kind: "transfer_in", amount: 0.05, hash: "0xinternal" })],
      new Map(),
      "WBTC",
    );
    expect(out).toEqual([]);
  });

  it("transfer_in matched но asset не совпадает → отбрасывается", () => {
    const out = enrichPurchaseEventsForCoverage(
      [ev({ kind: "transfer_in", amount: 0.05, hash: "0xusdc" })],
      mapOf(["0xusdc", 500, "USDC", "fiat-direct"]),
      "WBTC",
    );
    expect(out).toEqual([]);
  });

  it("lp_close_attribution с costUsd>0 → costSource='lp'", () => {
    const out = enrichPurchaseEventsForCoverage(
      [
        ev({
          kind: "lp_close_attribution",
          amount: 0.01,
          hash: "0xlp",
          costUsd: 620,
        }),
      ],
      new Map(),
      "WBTC",
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.costSource).toBe("lp");
    expect(out[0]!.costUsd).toBe(620);
  });

  it("lp_close_attribution с costUsd=0 → отбрасывается", () => {
    const out = enrichPurchaseEventsForCoverage(
      [
        ev({
          kind: "lp_close_attribution",
          amount: 0.01,
          hash: "0xlp",
          costUsd: 0,
        }),
      ],
      new Map(),
      "WBTC",
    );
    expect(out).toEqual([]);
  });

  it("sells / transfer_out / deploy → отбрасываются", () => {
    const out = enrichPurchaseEventsForCoverage(
      [
        ev({ kind: "sell_to_stable", amount: -1, hash: "0xa", costUsd: 50 }),
        ev({ kind: "transfer_out", amount: -0.5, hash: "0xb", costUsd: 25 }),
        ev({ kind: "deploy", amount: -1, hash: "0xc", costUsd: 50 }),
      ],
      new Map(),
      "WBTC",
    );
    expect(out).toEqual([]);
  });

  it("input order сохраняется (getPurchaseHistory сортирует на входе)", () => {
    // Контракт: enrichment не пере-сортирует, доверяет caller'у.
    // В production вход = getPurchaseHistory(ops, ...) который уже
    // отсортирован по op.time возрастающе.
    const out = enrichPurchaseEventsForCoverage(
      [
        ev({
          kind: "swap_from_stable",
          amount: 0.003,
          hash: "0xbuy",
          costUsd: 180,
          time: 1700000000,
        }),
        ev({
          kind: "transfer_in",
          amount: 0.09,
          hash: "0xCEX",
          time: 1700001000,
        }),
        ev({
          kind: "lp_close_attribution",
          amount: 0.01,
          hash: "0xlp",
          costUsd: 620,
          time: 1700002000,
        }),
      ],
      mapOf(["0xcex", 5400, "WBTC"]),
      "WBTC",
    );
    expect(out).toHaveLength(3);
    expect(out.map((e) => e.costSource)).toEqual(["direct", "cex", "lp"]);
    expect(out.map((e) => e.time)).toEqual([
      1700000000,
      1700001000,
      1700002000,
    ]);
  });

  it("hash match case-insensitive в обогащении тоже", () => {
    const out = enrichPurchaseEventsForCoverage(
      [ev({ kind: "transfer_in", amount: 0.1, hash: "0xMixed" })],
      mapOf(["0xmixed", 6000, "WBTC"]),
      "WBTC",
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.costSource).toBe("cex");
  });

  it("CEX match с costBasisUsd=0 (source=unknown) → показывается как 'cex' с costUsd=0", () => {
    // Диагностический сценарий: API key биржи без trade-permission →
    // server-side WAC-пул пустой → withdrawal возвращается с
    // costBasisUsd=0 и source='unknown'. На клиенте показываем как
    // «С биржи (BingX) — нет cost basis в пуле», чтобы пользователь
    // понял что нужно sync trades, а не считал это «непонятным
    // переводом».
    const out = enrichPurchaseEventsForCoverage(
      [ev({ kind: "transfer_in", amount: 0.1, hash: "0xnocost" })],
      mapOf(["0xnocost", 0, "WBTC", "unknown"]),
      "WBTC",
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.costSource).toBe("cex");
    expect(out[0]!.costUsd).toBe(0);
    expect(out[0]!.inheritanceSource).toBe("unknown");
  });
});

describe("enrichPurchaseEventsForCoverage — includeUnmatched (debug mode)", () => {
  it("default (без options) → unmatched transfer_in отбрасывается", () => {
    const out = enrichPurchaseEventsForCoverage(
      [ev({ kind: "transfer_in", amount: 0.1, hash: "0xinternal" })],
      new Map(),
      "WBTC",
    );
    expect(out).toEqual([]);
  });

  it("includeUnmatched=true → unmatched transfer_in включается с costSource='unknown'", () => {
    const out = enrichPurchaseEventsForCoverage(
      [
        ev({
          kind: "transfer_in",
          amount: 0.05,
          hash: "0xinternal",
          time: 1700000500,
        }),
      ],
      new Map(),
      "WBTC",
      { includeUnmatched: true },
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.costSource).toBe("unknown");
    expect(out[0]!.costUsd).toBe(0);
    expect(out[0]!.pricePerUnit).toBe(0);
    expect(out[0]!.hash).toBe("0xinternal");
    expect(out[0]!.amount).toBe(0.05);
  });

  it("includeUnmatched=true → CEX-matched всё равно costSource='cex' (не 'unknown')", () => {
    // Порядок проверок остаётся: если match найден — используем его,
    // только без match флаг переключает на 'unknown' вместо drop.
    const out = enrichPurchaseEventsForCoverage(
      [
        ev({ kind: "transfer_in", amount: 0.1, hash: "0xcex" }),
        ev({ kind: "transfer_in", amount: 0.05, hash: "0xinternal" }),
      ],
      mapOf(["0xcex", 6000, "WBTC"]),
      "WBTC",
      { includeUnmatched: true },
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.costSource).toBe("cex");
    expect(out[0]!.costUsd).toBe(6000);
    expect(out[1]!.costSource).toBe("unknown");
    expect(out[1]!.costUsd).toBe(0);
  });

  it("includeUnmatched=true → CEX-match с asset-mismatch тоже идёт в unknown (а не drop)", () => {
    // Хэш совпал, но asset биржи (USDC) ≠ target (WBTC) → не считаем
    // cex match, но в debug-режиме показываем чтобы пользователь видел.
    const out = enrichPurchaseEventsForCoverage(
      [ev({ kind: "transfer_in", amount: 0.1, hash: "0xwrong" })],
      mapOf(["0xwrong", 500, "USDC"]),
      "WBTC",
      { includeUnmatched: true },
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.costSource).toBe("unknown");
  });

  it("sells / transfer_out / deploy всё равно отбрасываются", () => {
    // includeUnmatched относится только к transfer_in. Out-events
    // никогда не нужны для cost basis.
    const out = enrichPurchaseEventsForCoverage(
      [
        ev({ kind: "sell_to_stable", amount: -1, hash: "0xs", costUsd: 50 }),
        ev({ kind: "transfer_out", amount: -0.5, hash: "0xo", costUsd: 25 }),
      ],
      new Map(),
      "WBTC",
      { includeUnmatched: true },
    );
    expect(out).toEqual([]);
  });
});
