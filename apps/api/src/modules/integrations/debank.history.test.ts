import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeBankClient } from "./debank.js";

interface FetchCall {
  url: string;
  headers: Record<string, string>;
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

function captureCall(input: string | URL, init?: RequestInit) {
  const url = typeof input === "string" ? input : input.toString();
  const headers: Record<string, string> = {};
  const initHeaders = init?.headers;
  if (initHeaders) {
    for (const [k, v] of Object.entries(initHeaders as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
  }
  calls.push({ url, headers });
}

function deBankItem(id: string, time: number) {
  return {
    id,
    chain: "eth",
    cate_id: null,
    time_at: time,
    project_id: null,
    cex_id: null,
    sends: [],
    receives: [],
    token_approve: null,
    tx: null,
  };
}

describe("DeBankClient.getHistory — auth + base", () => {
  it("injects AccessKey header and hits /v1/user/all_history_list", async () => {
    fetchSpy.mockImplementation(async (input, init) => {
      captureCall(input, init);
      return jsonResponse({
        history_list: [],
        token_dict: {},
        project_dict: {},
        cex_dict: {},
      });
    });
    const client = new DeBankClient("secret-key-xyz");
    await client.getHistory("0xaddr", { maxPages: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("pro-openapi.debank.com/v1/user/all_history_list");
    expect(calls[0]!.url).toContain("id=0xaddr");
    expect(calls[0]!.headers["accesskey"]).toBe("secret-key-xyz");
  });

  it("throws ProviderNotConfiguredError when API key absent", async () => {
    const client = new DeBankClient(undefined);
    await expect(client.getHistory("0xaddr")).rejects.toThrow(/not configured/i);
  });
});

describe("DeBankClient.getHistory — pagination", () => {
  it("paginates via start_time cursor, accumulates results across pages", async () => {
    let pageIdx = 0;
    fetchSpy.mockImplementation(async (input, init) => {
      captureCall(input, init);
      pageIdx++;
      if (pageIdx === 1) {
        return jsonResponse({
          history_list: Array.from({ length: 20 }, (_, i) =>
            deBankItem(`0xA${i}`, 2000 - i)
          ),
          token_dict: { "eth:usdc": { symbol: "USDC" } },
          project_dict: {},
          cex_dict: {},
        });
      }
      if (pageIdx === 2) {
        return jsonResponse({
          history_list: Array.from({ length: 15 }, (_, i) =>
            deBankItem(`0xB${i}`, 1000 - i)
          ),
          token_dict: { "eth:weth": { symbol: "WETH" } },
          project_dict: { aave: { id: "aave", name: "Aave" } },
          cex_dict: { binance: { id: "binance", name: "Binance" } },
        });
      }
      return jsonResponse({
        history_list: [],
        token_dict: {},
        project_dict: {},
        cex_dict: {},
      });
    });

    const client = new DeBankClient("key");
    const bundle = await client.getHistory("0xaddr");

    // Second call must include `start_time` (cursor from last item of page 1).
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).not.toContain("start_time");
    expect(calls[1]!.url).toContain("start_time=1981"); // 2000 - 19
    expect(bundle.history_list.length).toBe(35);
    expect(bundle.token_dict["eth:usdc"]).toBeDefined();
    expect(bundle.token_dict["eth:weth"]).toBeDefined();
    expect(bundle.project_dict["aave"]).toBeDefined();
    expect(bundle.cex_dict["binance"]).toBeDefined();
  });

  it("stops at maxPages even when more data is available", async () => {
    fetchSpy.mockImplementation(async (input, init) => {
      captureCall(input, init);
      return jsonResponse({
        history_list: Array.from({ length: 20 }, (_, i) =>
          deBankItem(`0x${calls.length}-${i}`, 10_000 - calls.length * 100 - i)
        ),
        token_dict: {},
        project_dict: {},
        cex_dict: {},
      });
    });
    const client = new DeBankClient("key");
    const bundle = await client.getHistory("0xaddr", { maxPages: 3 });
    expect(calls).toHaveLength(3);
    expect(bundle.history_list.length).toBe(60);
  });

  it("stops on partial page (< page_count items) — end of history", async () => {
    fetchSpy.mockImplementation(async (input, init) => {
      captureCall(input, init);
      return jsonResponse({
        history_list: [deBankItem("0xonly", 100)],
        token_dict: {},
        project_dict: {},
        cex_dict: {},
      });
    });
    const client = new DeBankClient("key");
    const bundle = await client.getHistory("0xaddr", { maxPages: 10 });
    expect(calls.length).toBe(1);
    expect(bundle.history_list.length).toBe(1);
  });

  it("deduplicates items if the API returns same id on adjacent pages", async () => {
    let p = 0;
    fetchSpy.mockImplementation(async (input, init) => {
      captureCall(input, init);
      p++;
      if (p === 1) {
        return jsonResponse({
          history_list: Array.from({ length: 20 }, (_, i) =>
            deBankItem(`0xA${i}`, 2000 - i)
          ),
          token_dict: {},
          project_dict: {},
          cex_dict: {},
        });
      }
      return jsonResponse({
        history_list: [
          deBankItem("0xA19", 2000 - 19), // duplicate
          deBankItem("0xB0", 1000),
        ],
        token_dict: {},
        project_dict: {},
        cex_dict: {},
      });
    });
    const client = new DeBankClient("key");
    const bundle = await client.getHistory("0xaddr", { maxPages: 5 });
    const ids = bundle.history_list.map((it) => it.id);
    expect(new Set(ids).size).toBe(ids.length); // unique
    expect(ids).toContain("0xA19");
    expect(ids).toContain("0xB0");
  });
});

describe("DeBankClient.getHistory — fail-soft", () => {
  it("non-OK status raises ProviderError", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({}, 502));
    const client = new DeBankClient("key");
    await expect(client.getHistory("0xaddr", { maxPages: 1 })).rejects.toThrow(
      /DeBank 502/
    );
  });
});
