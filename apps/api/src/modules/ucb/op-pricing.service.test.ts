/**
 * UCB B1 tests: op-pricing service builds the client-identical histPrices map
 * key (`${coin}|${bucketTs}`), mirrors the client movement filter, and honors
 * R5 (never cache a failed/zero lookup).
 */
import { describe, it, expect, vi } from "vitest";
import { defillamaCoinKey, bucketTs, cacheKeyFor } from "@cap-flow/ucb/pricing";
import type { ClassifiedOp } from "@cap-flow/ucb/types";

import {
  OpPricingService,
  collectPriceNeeds,
  type DefillamaFetch,
} from "./op-pricing.service.js";
import type {
  OpPriceInsert,
  OpPriceKey,
  OpPriceRow,
  OpPricingRepository,
} from "./op-pricing.repository.js";

const WBTC = "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f"; // arb WBTC
const USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831"; // arb USDC

function mv(p: Partial<ClassifiedOp["movement"][number]>): ClassifiedOp["movement"][number] {
  return {
    direction: "in",
    symbol: "WBTC",
    amount: 1,
    usd: 1,
    isStable: false,
    isProtocolToken: false,
    tokenId: WBTC,
    ...p,
  } as ClassifiedOp["movement"][number];
}
function op(p: Partial<ClassifiedOp>): ClassifiedOp {
  return {
    chain: "arb",
    time: 1772718771,
    type: "swap",
    hash: "0xabc",
    status: "ok",
    movement: [],
    ...p,
  } as ClassifiedOp;
}

class FakeRepo {
  rows: OpPriceInsert[] = [];
  seed: OpPriceRow[] = [];
  async getByKeys(keys: readonly OpPriceKey[]): Promise<OpPriceRow[]> {
    const want = new Set(keys.map((k) => `${k.coin}|${k.hourBucket}`));
    return this.seed.filter((r) => want.has(`${r.coin}|${r.hourBucket}`));
  }
  async upsertMany(rows: readonly OpPriceInsert[]): Promise<void> {
    this.rows.push(...rows);
  }
}
const svc = (repo: FakeRepo, fetcher?: DefillamaFetch) =>
  new OpPricingService(repo as unknown as OpPricingRepository, fetcher);

describe("collectPriceNeeds — mirrors client filter", () => {
  it("includes non-stable WBTC in-movement, excludes stable/protocol/gas/failed", () => {
    const ops: ClassifiedOp[] = [
      op({ movement: [mv({}), mv({ symbol: "USDC", tokenId: USDC, isStable: true })] }),
      op({ status: "failed", movement: [mv({})] }), // failed → skip
      op({ movement: [mv({ symbol: "ETH", tokenId: "arb", amount: 0.001 })] }), // gas → skip
      op({ movement: [mv({ isProtocolToken: true })] }), // receipt → skip
    ];
    const needs = collectPriceNeeds(ops);
    expect(needs).toHaveLength(1);
    const coin = defillamaCoinKey("arb", WBTC, "WBTC")!;
    expect(needs[0]!.coin).toBe(coin);
    expect(needs[0]!.hourBucket).toBe(bucketTs(1772718771));
  });

  it("dedupes same coin+hour across ops", () => {
    const ops = [op({}), op({ time: 1772718771 + 60 })].map((o) => ({
      ...o,
      movement: [mv({})],
    }));
    expect(collectPriceNeeds(ops)).toHaveLength(1); // same hour bucket
  });
});

describe("priceMapForOps — client-identical map key", () => {
  it("builds `${coin}|${bucketTs}` keys from cache, lists misses", async () => {
    const coin = defillamaCoinKey("arb", WBTC, "WBTC")!;
    const repo = new FakeRepo();
    repo.seed = [{ coin, hourBucket: bucketTs(1772718771), priceUsd: 74109.44 }];
    const ops = [op({ movement: [mv({})] })];
    const { histPrices, missing } = await svc(repo).priceMapForOps(ops);
    expect(histPrices.get(cacheKeyFor(coin, 1772718771))).toBeCloseTo(74109.44, 2);
    expect(missing).toHaveLength(0);
  });

  it("missing when cache empty", async () => {
    const repo = new FakeRepo();
    const { histPrices, missing } = await svc(repo).priceMapForOps([
      op({ movement: [mv({})] }),
    ]);
    expect(histPrices.size).toBe(0);
    expect(missing).toHaveLength(1);
  });
});

describe("fillMissing — R5 outage guard", () => {
  it("caches only price>0; drops zero/missing", async () => {
    const coinW = defillamaCoinKey("arb", WBTC, "WBTC")!;
    const repo = new FakeRepo();
    const fetcher: DefillamaFetch = vi.fn(async (_b, coins) => {
      const m = new Map<string, number>();
      // price the WBTC coin, but NOT some other coin (simulate partial)
      if (coins.includes(coinW)) m.set(coinW, 74000);
      return m;
    });
    const { written } = await svc(repo, fetcher).fillMissing([
      { coin: coinW, hourBucket: bucketTs(1772718771), timestamp: 1772718771, chain: "arb", tokenId: WBTC },
    ]);
    expect(written).toBe(1);
    expect(repo.rows[0]!.priceUsd).toBe(74000);
    expect(repo.rows[0]!.source).toBe("defillama");
  });

  it("writes NOTHING when fetch returns empty (503/outage)", async () => {
    const repo = new FakeRepo();
    const fetcher: DefillamaFetch = vi.fn(async () => new Map());
    const { written } = await svc(repo, fetcher).fillMissing([
      { coin: "x", hourBucket: 1, timestamp: 3600, chain: "arb", tokenId: null },
    ]);
    expect(written).toBe(0);
    expect(repo.rows).toHaveLength(0);
  });
});
