/**
 * PR-K4: localStorage cache для Krystal V3 positions.
 *
 * Krystal API стоит 10 credits/wallet/call. Без cache каждый page reload
 * сжигает credits. Cache TTL 24h — данные V3 LP меняются медленно (юзер
 * редко двигает liquidity), для current state day-old data ok с точностью
 * ~1% (price drift в течение суток).
 *
 * Storage layout:
 *   `capflow.cache.krystal.v1:<wallet_lowercase>` →
 *      { walletAddress, positions, fetchedAt }
 *
 * Read: stale entries (>TTL) treated as miss. Write: overwrites без TTL check.
 * Clear: для manual refresh ("обновить Krystal" UI button — future PR-K5).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearKrystalCacheForWallet,
  clearAllKrystalCache,
  readKrystalCache,
  writeKrystalCache,
} from "./cache";
import type { KrystalPosition } from "./types";

const W1 = "0x158b1cC8eCF697b74344486A795014b58bb2603E";
const W2 = "0xfcbc116A7F003641c85885e9a34bB448fd125Aa2";

// Vitest default node env — нет window/localStorage. Stub минимальный
// Storage API (как в src/lib/auth/csrf.test.ts).
interface MutableGlobal {
  window?: { localStorage: Storage };
  localStorage?: Storage;
}

function mountLocalStorage(): void {
  const store: Record<string, string> = {};
  const storage: Storage = {
    get length() {
      return Object.keys(store).length;
    },
    clear() {
      for (const k of Object.keys(store)) delete store[k];
    },
    getItem(k: string) {
      return Object.prototype.hasOwnProperty.call(store, k) ? store[k]! : null;
    },
    key(i: number) {
      return Object.keys(store)[i] ?? null;
    },
    removeItem(k: string) {
      delete store[k];
    },
    setItem(k: string, v: string) {
      store[k] = v;
    },
  };
  (globalThis as MutableGlobal).localStorage = storage;
  (globalThis as MutableGlobal).window = { localStorage: storage };
}

function unmountLocalStorage(): void {
  delete (globalThis as MutableGlobal).localStorage;
  delete (globalThis as MutableGlobal).window;
}

function makePos(tokenId: string): KrystalPosition {
  return {
    chain: { id: 42161, name: "Arbitrum", logo: "" },
    pool: {
      address: "0xpool",
      protocol: { key: "uniswapv3", name: "Uniswap V3", logo: "" },
      token0: { address: "0x0", symbol: "WETH", decimals: 18, name: "WETH", logo: "", priceUSD: 2000 },
      token1: { address: "0x1", symbol: "USDC", decimals: 6, name: "USDC", logo: "", priceUSD: 1 },
      tvl: 0, fee: 0.05, feeTier: 500,
      tick: 0, tickSpacing: 10, sqrtPriceX96: "0",
      currentTick: 0, currentPrice: 2000,
    },
    tokenId,
    liquidity: "1",
    currentPositionValue: 1000,
    currentAmounts: [],
    providedAmounts: [],
    feeApr: 0,
    farmApr: 0,
    totalApr: 0,
    status: "IN_RANGE",
    openedTime: 0,
    closedTime: null,
    tradingFee: { pending: [], claimed: [] },
    minPrice: 0, maxPrice: 1e18,
    isPositionInRange: true,
  } as unknown as KrystalPosition;
}

beforeEach(() => {
  mountLocalStorage();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-24T10:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  unmountLocalStorage();
});

describe("Krystal cache", () => {
  it("write + read fresh entry", () => {
    writeKrystalCache(W1, [makePos("111"), makePos("222")]);
    const out = readKrystalCache(W1);
    expect(out).toHaveLength(2);
    expect(out?.[0]!.tokenId).toBe("111");
  });

  it("wallet address case-insensitive", () => {
    writeKrystalCache(W1, [makePos("111")]);
    // Mixed case → lowercase normalization
    const out = readKrystalCache(W1.toUpperCase());
    expect(out).toHaveLength(1);
  });

  it("stale entry (>24h) returns null", () => {
    writeKrystalCache(W1, [makePos("111")]);
    // Advance time by 24h + 1ms
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
    expect(readKrystalCache(W1)).toBeNull();
  });

  it("fresh-by-1ms entry (23h59m59s) still valid", () => {
    writeKrystalCache(W1, [makePos("111")]);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 - 1);
    expect(readKrystalCache(W1)).not.toBeNull();
  });

  it("missing entry returns null (not throw)", () => {
    expect(readKrystalCache("0x0000000000000000000000000000000000000099")).toBeNull();
  });

  it("clearForWallet removes только указанный wallet, не трогает другие", () => {
    writeKrystalCache(W1, [makePos("111")]);
    writeKrystalCache(W2, [makePos("222")]);
    clearKrystalCacheForWallet(W1);
    expect(readKrystalCache(W1)).toBeNull();
    expect(readKrystalCache(W2)).not.toBeNull();
  });

  it("clearAll wipes все entries", () => {
    writeKrystalCache(W1, [makePos("111")]);
    writeKrystalCache(W2, [makePos("222")]);
    clearAllKrystalCache();
    expect(readKrystalCache(W1)).toBeNull();
    expect(readKrystalCache(W2)).toBeNull();
  });

  it("corrupted JSON в storage → treated as miss, не throw", () => {
    localStorage.setItem("capflow.cache.krystal.v1:" + W1.toLowerCase(), "{not json");
    expect(readKrystalCache(W1)).toBeNull();
  });

  it("entry без fetchedAt поля → treated as stale (legacy/migration safe)", () => {
    localStorage.setItem(
      "capflow.cache.krystal.v1:" + W1.toLowerCase(),
      JSON.stringify({ walletAddress: W1, positions: [makePos("111")] }),
    );
    expect(readKrystalCache(W1)).toBeNull();
  });

  it("clearAll не трогает не-Krystal ключи в localStorage", () => {
    localStorage.setItem("unrelated.key", "preserved");
    localStorage.setItem("capflow.auth.token", "stay");
    writeKrystalCache(W1, [makePos("111")]);
    clearAllKrystalCache();
    expect(localStorage.getItem("unrelated.key")).toBe("preserved");
    expect(localStorage.getItem("capflow.auth.token")).toBe("stay");
  });
});
