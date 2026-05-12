import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HeliusClient } from "./helius.js";

interface FetchCall {
  url: string;
}

let calls: FetchCall[];
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  calls = [];
  fetchSpy = vi.fn();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => vi.restoreAllMocks());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function tx(signature: string, time: number) {
  return {
    signature,
    timestamp: time,
    type: "TRANSFER",
    source: "SYSTEM_PROGRAM",
    slot: 0,
    fee: 5000,
    feePayer: "addr",
    nativeTransfers: [],
    tokenTransfers: [],
    transactionError: null,
  };
}

describe("HeliusClient.getTransactions — auth + base", () => {
  it("injects api-key query param and hits enhanced-transactions endpoint", async () => {
    fetchSpy.mockImplementation(async (input: string | URL) => {
      calls.push({ url: typeof input === "string" ? input : input.toString() });
      return jsonResponse([]);
    });
    const client = new HeliusClient("hel-secret");
    await client.getTransactions("SOLaddr111", { maxPages: 1 });
    expect(calls).toHaveLength(1);
    const u = new URL(calls[0]!.url);
    expect(u.origin + u.pathname).toBe(
      "https://api.helius.xyz/v0/addresses/SOLaddr111/transactions"
    );
    expect(u.searchParams.get("api-key")).toBe("hel-secret");
    expect(u.searchParams.get("limit")).toBe("100");
  });

  it("returns empty array when API key absent (no fetch)", async () => {
    const client = new HeliusClient(undefined);
    const r = await client.getTransactions("SOLaddr111");
    expect(r).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("HeliusClient.getTransactions — pagination", () => {
  it("walks pages via `before` cursor (last signature of prior page)", async () => {
    let p = 0;
    fetchSpy.mockImplementation(async (input: string | URL) => {
      calls.push({ url: typeof input === "string" ? input : input.toString() });
      p++;
      if (p === 1) {
        return jsonResponse(
          Array.from({ length: 100 }, (_, i) => tx(`sig-A-${i}`, 1000 - i))
        );
      }
      if (p === 2) {
        return jsonResponse(
          Array.from({ length: 50 }, (_, i) => tx(`sig-B-${i}`, 800 - i))
        );
      }
      return jsonResponse([]);
    });

    const client = new HeliusClient("hel-secret");
    const result = await client.getTransactions("SOLaddr111");

    expect(calls).toHaveLength(2);
    const second = new URL(calls[1]!.url);
    expect(second.searchParams.get("before")).toBe("sig-A-99");
    expect(result).toHaveLength(150);
  });

  it("stops at maxPages even with more data", async () => {
    fetchSpy.mockImplementation(async (input: string | URL) => {
      calls.push({ url: typeof input === "string" ? input : input.toString() });
      return jsonResponse(
        Array.from({ length: 100 }, (_, i) =>
          tx(`sig-${calls.length}-${i}`, 100_000 - calls.length * 1000 - i)
        )
      );
    });
    const client = new HeliusClient("hel-secret");
    const result = await client.getTransactions("SOLaddr111", { maxPages: 3 });
    expect(calls).toHaveLength(3);
    expect(result).toHaveLength(300);
  });

  it("stops on partial page (< 100 items)", async () => {
    fetchSpy.mockImplementation(async (input: string | URL) => {
      calls.push({ url: typeof input === "string" ? input : input.toString() });
      return jsonResponse([tx("sig-only", 100)]);
    });
    const client = new HeliusClient("hel-secret");
    const r = await client.getTransactions("SOLaddr111", { maxPages: 10 });
    expect(calls.length).toBe(1);
    expect(r).toHaveLength(1);
  });

  it("dedupes overlapping signatures across pages", async () => {
    let p = 0;
    fetchSpy.mockImplementation(async (input: string | URL) => {
      calls.push({ url: typeof input === "string" ? input : input.toString() });
      p++;
      if (p === 1) {
        return jsonResponse(
          Array.from({ length: 100 }, (_, i) => tx(`sig-${i}`, 1000 - i))
        );
      }
      return jsonResponse([
        tx("sig-99", 901), // duplicate of last item from page 1
        tx("sig-new", 900),
      ]);
    });
    const client = new HeliusClient("hel-secret");
    const r = await client.getTransactions("SOLaddr111", { maxPages: 5 });
    const sigs = r.map((t) => t.signature);
    expect(new Set(sigs).size).toBe(sigs.length);
    expect(sigs).toContain("sig-99");
    expect(sigs).toContain("sig-new");
  });
});

describe("HeliusClient.getTransactions — fail-soft", () => {
  it("non-OK status raises ProviderError", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse([], 503));
    const client = new HeliusClient("hel-secret");
    await expect(
      client.getTransactions("SOLaddr111", { maxPages: 1 })
    ).rejects.toThrow(/Helius 503/);
  });
});
