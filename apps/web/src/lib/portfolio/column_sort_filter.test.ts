import { describe, expect, it } from "vitest";

import type { OpenPosition } from "./open_positions";
import {
  applyColumnSortFilter,
  distinctColumnValues,
  getColumnCell,
  type CellContext,
} from "./column_sort_filter";

const CTX: CellContext = { sumCurrentUsd: 1000, locale: "en" };

function pos(args: Partial<OpenPosition> & { id: string }): OpenPosition {
  return {
    walletId: "w1",
    walletName: "main",
    walletChain: "evm",
    chain: "eth",
    protocol: { id: "uni", name: "Uniswap V3" } as OpenPosition["protocol"],
    kind: "lp",
    itemName: "Liquidity Pool",
    openedAt: null,
    openHash: null,
    ageDays: null,
    supplyTokens: [],
    debtTokens: [],
    openedInTokens: [],
    startUsd: 0,
    netStartUsd: 0,
    currentUsd: 0,
    currentDebtUsd: 0,
    healthRate: null,
    feesUsd: null,
    feesSource: null,
    feesClaimedUsd: 0,
    feesLifetimeUsd: 0,
    feeApr: null,
    feeAprLifetime: null,
    feesClaimedHistory: [],
    feesByToken: [],
    creditFundedUsd: 0,
    ...args,
  } as OpenPosition;
}

const ids = (ps: OpenPosition[]) => ps.map((p) => p.id);

describe("getColumnCell", () => {
  it("numeric столбец startUsd", () => {
    const c = getColumnCell(pos({ id: "POS-1", startUsd: 123.45 }), "startUsd", CTX);
    expect(c.kind).toBe("number");
    expect(c.sortKey).toBe(123.45);
    expect(c.values).toEqual(["$123.45"]);
  });

  it("multi-value столбец supplyTokens даёт все символы", () => {
    const c = getColumnCell(
      pos({ id: "POS-1", supplyTokens: [
        { symbol: "WETH", amount: 1, startUsd: 0, currentUsd: 0 } as never,
        { symbol: "USDC", amount: 1, startUsd: 0, currentUsd: 0 } as never,
      ] }),
      "supplyTokens",
      CTX,
    );
    expect(c.values).toEqual(["WETH", "USDC"]);
  });

  it("weight использует sumCurrentUsd из контекста", () => {
    const c = getColumnCell(pos({ id: "POS-1", currentUsd: 250 }), "weight", { sumCurrentUsd: 1000, locale: "en" });
    expect(c.sortKey).toBe(25); // 250/1000
    expect(c.values).toEqual(["25.0%"]);
  });

  it("null числа → sortKey null, value «—»", () => {
    const c = getColumnCell(pos({ id: "POS-1", ageDays: null }), "ageDays", CTX);
    expect(c.sortKey).toBeNull();
    expect(c.values).toEqual(["—"]);
  });
});

describe("applyColumnSortFilter — сортировка", () => {
  const data = [
    pos({ id: "POS-1", currentUsd: 50 }),
    pos({ id: "POS-2", currentUsd: 300 }),
    pos({ id: "POS-3", currentUsd: 100 }),
  ];

  it("по убыванию (числа)", () => {
    const out = applyColumnSortFilter(data, { sortCol: "currentUsd", sortDir: "desc", valueFilters: {} }, CTX);
    expect(ids(out)).toEqual(["POS-2", "POS-3", "POS-1"]);
  });

  it("по возрастанию (числа)", () => {
    const out = applyColumnSortFilter(data, { sortCol: "currentUsd", sortDir: "asc", valueFilters: {} }, CTX);
    expect(ids(out)).toEqual(["POS-1", "POS-3", "POS-2"]);
  });

  it("null/missing всегда в конце (обе стороны)", () => {
    const d = [
      pos({ id: "POS-1", ageDays: 10 }),
      pos({ id: "POS-2", ageDays: null }),
      pos({ id: "POS-3", ageDays: 5 }),
    ];
    expect(ids(applyColumnSortFilter(d, { sortCol: "ageDays", sortDir: "desc", valueFilters: {} }, CTX)))
      .toEqual(["POS-1", "POS-3", "POS-2"]);
    expect(ids(applyColumnSortFilter(d, { sortCol: "ageDays", sortDir: "asc", valueFilters: {} }, CTX)))
      .toEqual(["POS-3", "POS-1", "POS-2"]);
  });

  it("текстовая сортировка (протокол) A→Z", () => {
    const d = [
      pos({ id: "POS-1", protocol: { id: "u", name: "Uniswap V3" } as never }),
      pos({ id: "POS-2", protocol: { id: "a", name: "Aave V3" } as never }),
    ];
    expect(ids(applyColumnSortFilter(d, { sortCol: "protocol", sortDir: "asc", valueFilters: {} }, CTX)))
      .toEqual(["POS-2", "POS-1"]);
  });

  it("стабильна при равенстве (исходный порядок)", () => {
    const d = [pos({ id: "POS-1", currentUsd: 10 }), pos({ id: "POS-2", currentUsd: 10 })];
    expect(ids(applyColumnSortFilter(d, { sortCol: "currentUsd", sortDir: "desc", valueFilters: {} }, CTX)))
      .toEqual(["POS-1", "POS-2"]);
  });
});

describe("applyColumnSortFilter — value-фильтр", () => {
  const data = [
    pos({ id: "POS-1", chain: "eth" }),
    pos({ id: "POS-2", chain: "arb" }),
    pos({ id: "POS-3", chain: "eth" }),
  ];

  it("по одному значению столбца", () => {
    const out = applyColumnSortFilter(data, { sortCol: null, sortDir: "desc", valueFilters: { chain: ["ETH"] } }, CTX);
    expect(ids(out)).toEqual(["POS-1", "POS-3"]);
  });

  it("по нескольким значениям (OR внутри столбца)", () => {
    const out = applyColumnSortFilter(data, { sortCol: null, sortDir: "desc", valueFilters: { chain: ["ETH", "ARB"] } }, CTX);
    expect(ids(out)).toEqual(["POS-1", "POS-2", "POS-3"]);
  });

  it("multi-value столбец: строка проходит если ХОТЬ одно значение выбрано", () => {
    const d = [
      pos({ id: "POS-1", supplyTokens: [{ symbol: "WETH", amount: 1, startUsd: 0, currentUsd: 0 } as never, { symbol: "USDC", amount: 1, startUsd: 0, currentUsd: 0 } as never] }),
      pos({ id: "POS-2", supplyTokens: [{ symbol: "ARB", amount: 1, startUsd: 0, currentUsd: 0 } as never] }),
    ];
    const out = applyColumnSortFilter(d, { sortCol: null, sortDir: "desc", valueFilters: { supplyTokens: ["USDC"] } }, CTX);
    expect(ids(out)).toEqual(["POS-1"]);
  });

  it("пустой фильтр [] → не проходит ни одна строка", () => {
    const out = applyColumnSortFilter(data, { sortCol: null, sortDir: "desc", valueFilters: { chain: [] } }, CTX);
    expect(out).toHaveLength(0);
  });

  it("несколько столбцов = AND между столбцами", () => {
    const d = [
      pos({ id: "POS-1", chain: "eth", kind: "lp", itemName: "Liquidity Pool" }),
      pos({ id: "POS-2", chain: "eth", kind: "lending", itemName: "Lending" }),
    ];
    const out = applyColumnSortFilter(d, { sortCol: null, sortDir: "desc", valueFilters: { chain: ["ETH"], kind: ["Lending"] } }, CTX);
    expect(ids(out)).toEqual(["POS-2"]);
  });

  it("отсутствие ключа = фильтр не активен", () => {
    const out = applyColumnSortFilter(data, { sortCol: null, sortDir: "desc", valueFilters: {} }, CTX);
    expect(ids(out)).toEqual(["POS-1", "POS-2", "POS-3"]);
  });
});

describe("distinctColumnValues", () => {
  it("уникальные значения столбца, отсортированы", () => {
    const data = [
      pos({ id: "POS-1", chain: "eth" }),
      pos({ id: "POS-2", chain: "arb" }),
      pos({ id: "POS-3", chain: "eth" }),
    ];
    expect(distinctColumnValues(data, "chain", CTX)).toEqual(["ARB", "ETH"]);
  });

  it("multi-value: объединение всех токенов", () => {
    const data = [
      pos({ id: "POS-1", supplyTokens: [{ symbol: "WETH", amount: 1, startUsd: 0, currentUsd: 0 } as never, { symbol: "USDC", amount: 1, startUsd: 0, currentUsd: 0 } as never] }),
      pos({ id: "POS-2", supplyTokens: [{ symbol: "ARB", amount: 1, startUsd: 0, currentUsd: 0 } as never] }),
    ];
    expect(distinctColumnValues(data, "supplyTokens", CTX)).toEqual(["ARB", "USDC", "WETH"]);
  });
});
