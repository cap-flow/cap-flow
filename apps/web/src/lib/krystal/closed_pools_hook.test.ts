/**
 * Unit tests для filterClosedDustPositions — pure helper, тестируем без
 * React hook'а. Hook'овую часть (fetch + cache) проверяем integration-тестом
 * на проде (т.к. там реальный Krystal endpoint).
 */

import { describe, expect, it } from "vitest";

import { filterClosedDustPositions } from "./closed_pools_hook";

interface TestPos {
  id: string;
  walletId: string;
  chain: string;
  protocol: { name: string };
  matchedV3TokenId?: string;
  lpTokenId?: string;
  currentUsd: number;
}

// Mirror isV3LpProtocol — исключает lending protocols
const isV3 = (name: string): boolean => {
  if (/\b(aave|compound|comet|morpho|fluid|spark|radiant|euler)\b/i.test(name)) {
    return false;
  }
  return /\b(v3|v4)\b|concentrat|maverick|trader\s*joe|liquidity\s*book|algebra|kim/i.test(
    name,
  );
};

const W = "0x10b850c3abfca78d693c9cd6fce809c129109d1c";
const walletMap = new Map([["w1", W]]);

function pos(args: Partial<TestPos> & { id: string }): TestPos {
  return {
    walletId: "w1",
    chain: "base",
    protocol: { name: "Uniswap V3" },
    currentUsd: 4.57,
    lpTokenId: "0xd0b53d9277642d899df5c87a3966a349a798f224",
    ...args,
  };
}

describe("filterClosedDustPositions", () => {
  it("MMaksimuk POS-046: dust V3 LP в Krystal CLOSED пуле → скрывается", () => {
    const closedKeys = new Set([
      `${W.toLowerCase()}|base|0xd0b53d9277642d899df5c87a3966a349a798f224`,
    ]);
    const positions = [pos({ id: "POS-046" })];
    const out = filterClosedDustPositions(
      positions,
      walletMap,
      closedKeys,
      isV3,
    );
    expect(out).toHaveLength(0);
  });

  it("активная V3 LP с matchedV3TokenId — НЕ трогается даже если pool в CLOSED Set", () => {
    // защитный guard: matched позиция точно активна, не наш case
    const closedKeys = new Set([
      `${W.toLowerCase()}|base|0xd0b53d9277642d899df5c87a3966a349a798f224`,
    ]);
    const positions = [
      pos({ id: "POS-X", matchedV3TokenId: "12345" }),
    ];
    const out = filterClosedDustPositions(
      positions,
      walletMap,
      closedKeys,
      isV3,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("POS-X");
  });

  it("currentUsd ≥ $50 — НЕ трогается (dust threshold защищает от ложных CLOSED)", () => {
    const closedKeys = new Set([
      `${W.toLowerCase()}|base|0xd0b53d9277642d899df5c87a3966a349a798f224`,
    ]);
    const positions = [pos({ id: "POS-BIG", currentUsd: 100 })];
    const out = filterClosedDustPositions(
      positions,
      walletMap,
      closedKeys,
      isV3,
    );
    expect(out).toHaveLength(1);
  });

  it("pool не в CLOSED Set — позиция остаётся", () => {
    const closedKeys = new Set([
      `${W.toLowerCase()}|base|0xother_pool`,
    ]);
    const positions = [pos({ id: "POS-OK" })];
    const out = filterClosedDustPositions(
      positions,
      walletMap,
      closedKeys,
      isV3,
    );
    expect(out).toHaveLength(1);
  });

  it("non-V3 LP протокол — НЕ трогается (lending, GMX, etc.)", () => {
    const closedKeys = new Set([
      `${W.toLowerCase()}|base|0xd0b53d9277642d899df5c87a3966a349a798f224`,
    ]);
    const positions = [
      pos({ id: "POS-LEND", protocol: { name: "Aave V3" } }),
    ];
    const out = filterClosedDustPositions(
      positions,
      walletMap,
      closedKeys,
      isV3,
    );
    expect(out).toHaveLength(1);
  });

  it("нет lpTokenId — НЕ трогается (нечем матчить против CLOSED Set)", () => {
    const closedKeys = new Set([
      `${W.toLowerCase()}|base|0xd0b53d9277642d899df5c87a3966a349a798f224`,
    ]);
    const positions = [pos({ id: "POS-NO-POOL", lpTokenId: undefined })];
    const out = filterClosedDustPositions(
      positions,
      walletMap,
      closedKeys,
      isV3,
    );
    expect(out).toHaveLength(1);
  });

  it("walletAddressById не содержит walletId — НЕ трогается (fail-safe)", () => {
    const closedKeys = new Set([
      `${W.toLowerCase()}|base|0xd0b53d9277642d899df5c87a3966a349a798f224`,
    ]);
    const positions = [pos({ id: "POS-UNKNOWN", walletId: "w-unknown" })];
    const out = filterClosedDustPositions(
      positions,
      new Map(),
      closedKeys,
      isV3,
    );
    expect(out).toHaveLength(1);
  });

  it("пустой closedKeys Set — fail-soft, возвращает всё без изменений", () => {
    const positions = [
      pos({ id: "POS-A" }),
      pos({ id: "POS-B", currentUsd: 100 }),
    ];
    const out = filterClosedDustPositions(positions, walletMap, new Set(), isV3);
    expect(out).toHaveLength(2);
  });

  it("multiple positions — фильтруются только dust V3 LP в CLOSED пулах", () => {
    const closedKeys = new Set([
      `${W.toLowerCase()}|base|0xd0b53d9277642d899df5c87a3966a349a798f224`,
    ]);
    const positions: TestPos[] = [
      pos({ id: "POS-046", currentUsd: 4.57 }), // SKIP — dust closed
      pos({ id: "POS-013", currentUsd: 24.45, lpTokenId: "0x6c561b446416e1a00e8e93e221854d6ea4171372" }), // KEEP — другой pool
      pos({ id: "POS-OTHER", currentUsd: 500, protocol: { name: "Uniswap V3" } }), // KEEP — слишком большой
      pos({ id: "POS-MATCHED", matchedV3TokenId: "5266800" }), // KEEP — matched
    ];
    const out = filterClosedDustPositions(
      positions,
      walletMap,
      closedKeys,
      isV3,
    );
    expect(out.map((p) => p.id).sort()).toEqual([
      "POS-013",
      "POS-MATCHED",
      "POS-OTHER",
    ]);
  });

  it("кастомный dustThresholdUsd параметр", () => {
    const closedKeys = new Set([
      `${W.toLowerCase()}|base|0xd0b53d9277642d899df5c87a3966a349a798f224`,
    ]);
    const positions = [pos({ id: "POS-X", currentUsd: 30 })];
    // default $50 → отфильтрует
    expect(
      filterClosedDustPositions(positions, walletMap, closedKeys, isV3),
    ).toHaveLength(0);
    // custom $10 → НЕ отфильтрует ($30 > $10)
    expect(
      filterClosedDustPositions(positions, walletMap, closedKeys, isV3, 10),
    ).toHaveLength(1);
  });

  it("chain case-insensitive matching", () => {
    const closedKeys = new Set([
      `${W.toLowerCase()}|base|0xd0b53d9277642d899df5c87a3966a349a798f224`,
    ]);
    const positions = [pos({ id: "POS-X", chain: "BASE" })];
    const out = filterClosedDustPositions(
      positions,
      walletMap,
      closedKeys,
      isV3,
    );
    expect(out).toHaveLength(0);
  });
});
