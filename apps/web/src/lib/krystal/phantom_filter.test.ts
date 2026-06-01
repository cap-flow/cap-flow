/**
 * Krystal-absent V3 phantom filter — drops closed/never-real DeBank dust,
 * never hides real (incl. gauge-staked) positions.
 */
import { describe, it, expect } from "vitest";

import {
  buildKrystalOpenIndex,
  filterKrystalAbsentV3Phantoms,
  type KrystalOpenIndex,
} from "./phantom_filter";

const isV3 = (n: string) =>
  /uniswap v3|uniswap v4|pancakeswap v3|velodrome v3/i.test(n);

const WALLET = "0x10b850c3abfca78d693c9cd6fce809c129109d1c";
const addrById = new Map([["w1", WALLET]]);

// Krystal returned a real open Uniswap V3 position on eth (proves Krystal up
// for this wallet) — but nothing on base.
const openIndex: KrystalOpenIndex = buildKrystalOpenIndex([
  {
    tokenId: "1196206",
    chainCode: "eth",
    ownerAddress: WALLET,
    poolAddress: "0x877da2662c8454417d69399b20f570ea4f1a44df",
  } as never,
]);

function pos(over: Record<string, unknown>) {
  return {
    walletId: "w1",
    chain: "base",
    protocol: { name: "Uniswap V3" },
    matchedV3TokenId: undefined as string | undefined,
    lpTokenId: "0x529d2863a1521d0b57db028168fde2e97120017c",
    currentUsd: 24,
    ...over,
  };
}

describe("filterKrystalAbsentV3Phantoms", () => {
  it("drops a never-real DeBank-only phantom (POS-039 VIRTUAL/USDC)", () => {
    const r = filterKrystalAbsentV3Phantoms([pos({})], addrById, openIndex, isV3);
    expect(r.positions).toHaveLength(0);
    expect(r.dropped).toHaveLength(1);
  });

  it("drops a closed-residual dust phantom (POS-014 WETH/USDC $9.72)", () => {
    const r = filterKrystalAbsentV3Phantoms(
      [pos({ lpTokenId: "0x6c561b446416e1a00e8e93e221854d6ea4171372", currentUsd: 9.72 })],
      addrById, openIndex, isV3,
    );
    expect(r.positions).toHaveLength(0);
  });

  it("KEEPS gauge-staked CL (has matchedV3TokenId) even though Krystal can't see it", () => {
    const r = filterKrystalAbsentV3Phantoms(
      [pos({ chain: "op", protocol: { name: "Velodrome V3" }, matchedV3TokenId: "3427934", currentUsd: 112 })],
      addrById, openIndex, isV3,
    );
    expect(r.positions).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
  });

  it("KEEPS a real position Krystal lists as open", () => {
    const r = filterKrystalAbsentV3Phantoms(
      [pos({ chain: "eth", lpTokenId: "0x877da2662c8454417d69399b20f570ea4f1a44df", currentUsd: 30 })],
      addrById, openIndex, isV3,
    );
    expect(r.positions).toHaveLength(1);
  });

  it("fail-soft: KEEPS everything when Krystal returned nothing (down/unauth)", () => {
    const empty = buildKrystalOpenIndex([]);
    const r = filterKrystalAbsentV3Phantoms([pos({})], addrById, empty, isV3);
    expect(r.positions).toHaveLength(1);
  });

  it("KEEPS positions on a Krystal-uncovered chain (e.g. plasma)", () => {
    const r = filterKrystalAbsentV3Phantoms([pos({ chain: "plasma" })], addrById, openIndex, isV3);
    expect(r.positions).toHaveLength(1);
  });

  it("KEEPS a large position (above dust threshold) — defense in depth", () => {
    const r = filterKrystalAbsentV3Phantoms([pos({ currentUsd: 5000 })], addrById, openIndex, isV3);
    expect(r.positions).toHaveLength(1);
  });

  it("KEEPS non-V3-LP positions untouched", () => {
    const r = filterKrystalAbsentV3Phantoms(
      [pos({ protocol: { name: "Aave V3" }, currentUsd: 5 })],
      addrById, openIndex, isV3,
    );
    expect(r.positions).toHaveLength(1);
  });
});
