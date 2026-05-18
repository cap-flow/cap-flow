/**
 * UCB D9: tests для priceFromMapNearest (sparse hist-data fallback).
 *
 * Map keys имеют format `${coin}|${bucket_ts}` где bucket_ts = floor(ts/3600)*3600.
 */
import { describe, expect, it } from "vitest";

import { priceFromMapNearest } from "./defillama";

const HOUR = 3600;

function bucket(ts: number): number {
  return Math.floor(ts / HOUR) * HOUR;
}

describe("priceFromMapNearest — UCB D9", () => {
  it("exact hit returns offsetHours=0", () => {
    const m = new Map<string, number>();
    const ts = 1735689600; // 2025-01-01 00:00:00 UTC
    m.set(`eth:ethereum|${bucket(ts)}`, 3000);
    const r = priceFromMapNearest(m, "eth:ethereum", ts);
    expect(r).toEqual({ price: 3000, offsetHours: 0 });
  });

  it("miss с близким bucket'ом возвращает nearest", () => {
    const m = new Map<string, number>();
    const target = 1735689600; // T
    // Нет точно на T, но есть на T-2h и T+5h. Должен взять T-2h.
    m.set(`eth:ethereum|${bucket(target - 2 * HOUR)}`, 2950);
    m.set(`eth:ethereum|${bucket(target + 5 * HOUR)}`, 3050);
    const r = priceFromMapNearest(m, "eth:ethereum", target);
    expect(r?.price).toBe(2950);
    expect(r?.offsetHours).toBe(2);
  });

  it("за пределами окна ±7d → null", () => {
    const m = new Map<string, number>();
    const target = 1735689600;
    // Цена есть, но в 10 днях
    m.set(`eth:ethereum|${bucket(target - 10 * 24 * HOUR)}`, 2900);
    expect(priceFromMapNearest(m, "eth:ethereum", target)).toBeNull();
  });

  it("кастомное окно: ±1h", () => {
    const m = new Map<string, number>();
    const target = 1735689600;
    m.set(`eth:ethereum|${bucket(target - 2 * HOUR)}`, 2950);
    expect(priceFromMapNearest(m, "eth:ethereum", target, 1)).toBeNull();
    expect(priceFromMapNearest(m, "eth:ethereum", target, 3)?.price).toBe(2950);
  });

  it("игнорирует другие coins в map", () => {
    const m = new Map<string, number>();
    const target = 1735689600;
    m.set(`btc:bitcoin|${bucket(target)}`, 100000);
    m.set(`eth:ethereum|${bucket(target - 100 * HOUR)}`, 2950);
    // Ищем ETH, BTC не должен match
    const r = priceFromMapNearest(m, "eth:ethereum", target);
    expect(r?.price).toBe(2950);
  });

  it("игнорирует zero / negative prices", () => {
    const m = new Map<string, number>();
    const target = 1735689600;
    m.set(`eth:ethereum|${bucket(target)}`, 0);
    m.set(`eth:ethereum|${bucket(target + 3 * HOUR)}`, -1);
    m.set(`eth:ethereum|${bucket(target + 5 * HOUR)}`, 3000);
    const r = priceFromMapNearest(m, "eth:ethereum", target);
    expect(r?.price).toBe(3000);
    expect(r?.offsetHours).toBe(5);
  });

  it("empty map → null", () => {
    expect(priceFromMapNearest(new Map(), "eth", 1)).toBeNull();
  });
});
