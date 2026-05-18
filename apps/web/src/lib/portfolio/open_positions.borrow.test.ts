/**
 * UCB D7: tests for computeBorrowProceedsUsd (net cost basis helper).
 *
 * Хотя функция internal, мы тестируем через её влияние на OpenPosition.
 * Здесь — narrow unit tests на саму вычислительную логику через
 * dynamic import к internal export тестировать сложно (нет export).
 *
 * Поэтому проверяем семантику на проне через `buildOpenPositions` later,
 * а здесь — простые scenarios. Если функция изменится — этот файл
 * можно обновить или удалить.
 */
import { describe, expect, it } from "vitest";

import type { ClassifiedOp } from "./types";

// Re-export internal helper для теста: технически грязный, но альтернатива —
// integration через buildOpenPositions очень тяжёлая. Используем dynamic
// pattern.
async function loadHelper(): Promise<
  (
    ops: ClassifiedOp[],
    protocolId: string,
    chain: string,
  ) => number
> {
  const mod: Record<string, unknown> = await import("./open_positions");
  return mod.computeBorrowProceedsUsd as Parameters<typeof loadHelper>[0] extends never ? never : (
    ops: ClassifiedOp[],
    protocolId: string,
    chain: string,
  ) => number;
}

function borrowOp(amount: number, usd: number): ClassifiedOp {
  return {
    hash: "0xborrow" + Math.random(),
    type: "borrow",
    time: 1000,
    chain: "arb",
    status: "success",
    movement: [
      {
        direction: "in",
        symbol: "USDC",
        amount,
        usd,
        tokenId: "usdc-arb",
        isStable: true,
      },
    ],
    fnName: "",
    cateId: "",
    counter: "",
    counterName: "",
    project: null,
    protocol: { id: "aave_v3", name: "Aave V3", category: "lending" },
    fees: { gasUsd: 0, otherUsd: 0 },
    notes: [],
    seq: 0,
    isInternal: false,
    counterAddresses: [],
    netUsd: 0,
    gasUsd: 0,
  } as ClassifiedOp;
}

function repayOp(amount: number, usd: number): ClassifiedOp {
  return {
    hash: "0xrepay" + Math.random(),
    type: "repay",
    time: 2000,
    chain: "arb",
    status: "success",
    movement: [
      {
        direction: "out",
        symbol: "USDC",
        amount,
        usd,
        tokenId: "usdc-arb",
        isStable: true,
      },
    ],
    fnName: "",
    cateId: "",
    counter: "",
    counterName: "",
    project: null,
    protocol: { id: "aave_v3", name: "Aave V3", category: "lending" },
    fees: { gasUsd: 0, otherUsd: 0 },
    notes: [],
    seq: 0,
    isInternal: false,
    counterAddresses: [],
    netUsd: 0,
    gasUsd: 0,
  } as ClassifiedOp;
}

describe("computeBorrowProceedsUsd — UCB D7", () => {
  it("одиночный borrow → возвращает amount.usd", async () => {
    const fn = await loadHelper();
    expect(fn([borrowOp(1000, 1000)], "aave_v3", "arb")).toBe(1000);
  });

  it("borrow затем full repay → 0", async () => {
    const fn = await loadHelper();
    const ops = [borrowOp(1000, 1000), repayOp(1000, 1000)];
    expect(fn(ops, "aave_v3", "arb")).toBe(0);
  });

  it("borrow $1000, repay $400 → 600 net", async () => {
    const fn = await loadHelper();
    const ops = [borrowOp(1000, 1000), repayOp(400, 400)];
    expect(fn(ops, "aave_v3", "arb")).toBe(600);
  });

  it("repay > borrow → clamped to 0", async () => {
    const fn = await loadHelper();
    const ops = [borrowOp(100, 100), repayOp(500, 500)];
    expect(fn(ops, "aave_v3", "arb")).toBe(0);
  });

  it("игнорирует другие protocols / chains", async () => {
    const fn = await loadHelper();
    const op1 = borrowOp(1000, 1000);
    const op2: ClassifiedOp = { ...borrowOp(500, 500), chain: "eth" } as ClassifiedOp;
    expect(fn([op1, op2], "aave_v3", "arb")).toBe(1000);
  });
});
