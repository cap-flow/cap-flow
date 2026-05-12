import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetDefillamaCache,
  defillamaBaseUrl,
  fetchHistoricalPrices,
} from "./defillama_prices.js";

const ETH_KEY = "coingecko:ethereum";
const BTC_KEY = "coingecko:bitcoin";
const SOL_KEY = "coingecko:solana";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

let calls: FetchCall[] = [];
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  __resetDefillamaCache();
  calls = [];
  fetchSpy = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return mockResponse(url);
  });
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Default mock: returns a price for each coin in the URL using simple table. */
function mockResponse(url: string): Response {
  // url shape: ${BASE}/prices/historical/{ts}/{coins}?searchWidth=4h
  const match = url.match(/historical\/(\d+)\/([^?]+)/);
  if (!match) return jsonResponse({ coins: {} });
  const coinsCsv = decodeURIComponent(match[2]!);
  const coins = coinsCsv.split(",");
  const out: Record<string, { price: number }> = {};
  for (const c of coins) {
    if (c === ETH_KEY) out[c] = { price: 2000 };
    if (c === BTC_KEY) out[c] = { price: 40000 };
    if (c === SOL_KEY) out[c] = { price: 100 };
    if (c.startsWith("nope:")) {
      /* missing on purpose */
    }
  }
  return jsonResponse({ coins: out });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/* ------------------------- baseline contract ------------------------------- */

describe("fetchHistoricalPrices — baseline", () => {
  it("returns empty Map for empty input without calling fetch", async () => {
    const r = await fetchHistoricalPrices([]);
    expect(r.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches single coin/timestamp and indexes by cacheKey", async () => {
    const r = await fetchHistoricalPrices([
      { coin: ETH_KEY, timestamp: 3600 + 100 },
    ]);
    expect(r.get(`${ETH_KEY}|3600`)).toBe(2000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("hits hour bucket via bucketTs in URL", async () => {
    await fetchHistoricalPrices([{ coin: ETH_KEY, timestamp: 3600 + 999 }]);
    const u = calls[0]!.url;
    expect(u).toContain("/historical/3600/");
    expect(u).toContain(ETH_KEY);
    expect(u).toContain("searchWidth=4h");
    expect(u.startsWith(defillamaBaseUrl())).toBe(true);
  });
});

/* ------------------------- caching ----------------------------------------- */

describe("fetchHistoricalPrices — cache", () => {
  it("second call with same (coin, hour) does not refetch", async () => {
    await fetchHistoricalPrices([{ coin: ETH_KEY, timestamp: 3600 }]);
    await fetchHistoricalPrices([{ coin: ETH_KEY, timestamp: 3600 + 500 }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("different hour buckets → separate fetches", async () => {
    await fetchHistoricalPrices([{ coin: ETH_KEY, timestamp: 3600 }]);
    await fetchHistoricalPrices([{ coin: ETH_KEY, timestamp: 7200 }]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("__resetDefillamaCache clears cache between tests", async () => {
    await fetchHistoricalPrices([{ coin: ETH_KEY, timestamp: 3600 }]);
    __resetDefillamaCache();
    await fetchHistoricalPrices([{ coin: ETH_KEY, timestamp: 3600 }]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

/* ------------------------- grouping + dedup -------------------------------- */

describe("fetchHistoricalPrices — grouping", () => {
  it("groups coins sharing the same hour bucket into one request", async () => {
    await fetchHistoricalPrices([
      { coin: ETH_KEY, timestamp: 3600 + 100 },
      { coin: BTC_KEY, timestamp: 3600 + 200 },
      { coin: SOL_KEY, timestamp: 3600 + 300 },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(calls[0]!.url).toContain(ETH_KEY);
    expect(calls[0]!.url).toContain(BTC_KEY);
    expect(calls[0]!.url).toContain(SOL_KEY);
  });

  it("splits coins into separate hour buckets", async () => {
    await fetchHistoricalPrices([
      { coin: ETH_KEY, timestamp: 3600 + 100 },
      { coin: BTC_KEY, timestamp: 7200 + 100 },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("deduplicates duplicate (coin, bucket) within a single call", async () => {
    await fetchHistoricalPrices([
      { coin: ETH_KEY, timestamp: 3600 + 100 },
      { coin: ETH_KEY, timestamp: 3600 + 200 },
      { coin: ETH_KEY, timestamp: 3600 + 300 },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // URL has only one ETH_KEY mention.
    const eths = calls[0]!.url.match(/coingecko:ethereum/g) ?? [];
    expect(eths.length).toBe(1);
  });
});

/* ------------------------- chunking ---------------------------------------- */

describe("fetchHistoricalPrices — chunking (50 coins per URL)", () => {
  it("splits >50 coins per bucket into multiple fetches", async () => {
    const items: { coin: string; timestamp: number }[] = [];
    for (let i = 0; i < 75; i++) {
      items.push({ coin: `coingecko:coin${i}`, timestamp: 3600 });
    }
    await fetchHistoricalPrices(items);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("single-chunk for ≤50 coins", async () => {
    const items: { coin: string; timestamp: number }[] = [];
    for (let i = 0; i < 50; i++) {
      items.push({ coin: `coingecko:coin${i}`, timestamp: 3600 });
    }
    await fetchHistoricalPrices(items);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------- error handling ---------------------------------- */

describe("fetchHistoricalPrices — error resilience", () => {
  it("non-OK status for a chunk is swallowed; other chunks still cached", async () => {
    let n = 0;
    fetchSpy.mockImplementation(async (input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init: undefined });
      n++;
      if (n === 1) return jsonResponse({}, 500);
      return mockResponse(url);
    });
    const items: { coin: string; timestamp: number }[] = [];
    for (let i = 0; i < 75; i++) {
      items.push({ coin: `coingecko:coin${i}`, timestamp: 3600 });
    }
    items.push({ coin: ETH_KEY, timestamp: 3600 });
    const r = await fetchHistoricalPrices(items);
    // First chunk (50 coins) → 500, results empty.
    // Second chunk (coin50..74 + ETH_KEY = 26) → 200 with ETH price.
    expect(r.get(`${ETH_KEY}|3600`)).toBe(2000);
  });

  it("network error inside fetch is swallowed", async () => {
    fetchSpy.mockImplementation(async () => {
      throw new Error("network");
    });
    const r = await fetchHistoricalPrices([
      { coin: ETH_KEY, timestamp: 3600 },
    ]);
    expect(r.size).toBe(0);
  });

  it("items with price=0 or missing price are not put into result", async () => {
    fetchSpy.mockImplementation(async () =>
      jsonResponse({
        coins: {
          [ETH_KEY]: { price: 0 },
          [BTC_KEY]: { /* no price */ symbol: "BTC" },
          [SOL_KEY]: { price: 100 },
        },
      })
    );
    const r = await fetchHistoricalPrices([
      { coin: ETH_KEY, timestamp: 3600 },
      { coin: BTC_KEY, timestamp: 3600 },
      { coin: SOL_KEY, timestamp: 3600 },
    ]);
    expect(r.has(`${ETH_KEY}|3600`)).toBe(false);
    expect(r.has(`${BTC_KEY}|3600`)).toBe(false);
    expect(r.get(`${SOL_KEY}|3600`)).toBe(100);
  });
});

/* ------------------------- abort ------------------------------------------- */

describe("fetchHistoricalPrices — abort", () => {
  it("does not start new chunk after abort signal is set", async () => {
    const ac = new AbortController();
    let n = 0;
    fetchSpy.mockImplementation(async (input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init: undefined });
      n++;
      // Abort right after the first chunk completes.
      if (n === 1) ac.abort();
      return mockResponse(url);
    });
    const items: { coin: string; timestamp: number }[] = [];
    for (let bucket = 1; bucket <= 5; bucket++) {
      items.push({ coin: ETH_KEY, timestamp: bucket * 3600 });
    }
    await fetchHistoricalPrices(items, ac.signal);
    expect(n).toBeLessThan(items.length);
  });
});
