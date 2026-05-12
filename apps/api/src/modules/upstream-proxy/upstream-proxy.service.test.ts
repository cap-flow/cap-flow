import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  UpstreamProxyService,
  UpstreamProxyError,
  type ProxyEnv,
} from "./upstream-proxy.service.js";

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

let calls: FetchCall[];
let fetchSpy: ReturnType<typeof vi.fn>;

const ENV: ProxyEnv = {
  DEBANK_API_KEY: "debank-secret-xyz",
  HELIUS_API_KEY: "helius-secret-xyz",
  ETHERSCAN_API_KEY: "etherscan-secret-xyz",
  ALCHEMY_API_KEY: "alchemy-secret-xyz",
};

function makeSvc(envOverride?: Partial<ProxyEnv>): UpstreamProxyService {
  return new UpstreamProxyService({ ...ENV, ...envOverride });
}

beforeEach(() => {
  calls = [];
  fetchSpy = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    const initHeaders = init?.headers;
    if (initHeaders) {
      const entries =
        initHeaders instanceof Headers
          ? Array.from(initHeaders.entries())
          : Array.isArray(initHeaders)
            ? initHeaders
            : Object.entries(initHeaders);
      for (const [k, v] of entries) headers[String(k).toLowerCase()] = String(v);
    }
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    });
    return new Response(JSON.stringify({ ok: true, url }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => vi.restoreAllMocks());

/* ------------------------- DeBank ----------------------------------------- */

describe("UpstreamProxyService — DeBank", () => {
  it("injects AccessKey header, forwards to pro-openapi.debank.com", async () => {
    const svc = makeSvc();
    const r = await svc.forward({
      provider: "debank",
      method: "GET",
      path: "v1/user/total_balance",
      query: { id: "0xabc" },
    });
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://pro-openapi.debank.com/v1/user/total_balance?id=0xabc"
    );
    expect(calls[0]!.headers["accesskey"]).toBe("debank-secret-xyz");
  });

  it("rejects unknown DeBank path (SSRF protection)", async () => {
    const svc = makeSvc();
    await expect(
      svc.forward({ provider: "debank", method: "GET", path: "admin/keys" })
    ).rejects.toBeInstanceOf(UpstreamProxyError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects when API key not configured", async () => {
    const svc = makeSvc({ DEBANK_API_KEY: undefined });
    await expect(
      svc.forward({ provider: "debank", method: "GET", path: "v1/user/total_balance" })
    ).rejects.toBeInstanceOf(UpstreamProxyError);
  });
});

/* ------------------------- Helius ----------------------------------------- */

describe("UpstreamProxyService — Helius", () => {
  it("injects api-key into query, forwards to api.helius.xyz", async () => {
    const svc = makeSvc();
    await svc.forward({
      provider: "helius",
      method: "GET",
      path: "v0/addresses/SoLwallet/balances",
    });
    expect(calls[0]!.url).toBe(
      "https://api.helius.xyz/v0/addresses/SoLwallet/balances?api-key=helius-secret-xyz"
    );
  });

  it("preserves caller-supplied query params alongside api-key", async () => {
    const svc = makeSvc();
    await svc.forward({
      provider: "helius",
      method: "GET",
      path: "v0/addresses/SoLwallet/transactions",
      query: { limit: "100", before: "sigX" },
    });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("before")).toBe("sigX");
    expect(url.searchParams.get("api-key")).toBe("helius-secret-xyz");
  });

  it("does NOT honour caller-supplied api-key (key always from env)", async () => {
    const svc = makeSvc();
    await svc.forward({
      provider: "helius",
      method: "GET",
      path: "v0/addresses/SoLwallet/balances",
      // Hostile client tries to override the secret.
      query: { "api-key": "client-injected-fake" },
    });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("api-key")).toBe("helius-secret-xyz");
  });
});

/* ------------------------- Etherscan -------------------------------------- */

describe("UpstreamProxyService — Etherscan", () => {
  it("injects apikey query param to api.etherscan.io", async () => {
    const svc = makeSvc();
    await svc.forward({
      provider: "etherscan",
      method: "GET",
      path: "v2/api",
      query: { chainId: "1", module: "logs", action: "getLogs" },
    });
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe(
      "https://api.etherscan.io/v2/api"
    );
    expect(url.searchParams.get("apikey")).toBe("etherscan-secret-xyz");
    expect(url.searchParams.get("chainId")).toBe("1");
  });
});

/* ------------------------- Alchemy ---------------------------------------- */

describe("UpstreamProxyService — Alchemy", () => {
  it("uses chain-specific subdomain and embeds key into path", async () => {
    const svc = makeSvc();
    await svc.forward({
      provider: "alchemy",
      method: "POST",
      path: "eth-mainnet",
      body: { jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 },
    });
    expect(calls[0]!.url).toBe(
      "https://eth-mainnet.g.alchemy.com/v2/alchemy-secret-xyz"
    );
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["content-type"]).toMatch(/application\/json/);
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      jsonrpc: "2.0",
      method: "eth_blockNumber",
      params: [],
      id: 1,
    });
  });

  it.each([
    "eth-mainnet",
    "arb-mainnet",
    "opt-mainnet",
    "base-mainnet",
    "polygon-mainnet",
    "bnb-mainnet",
  ])("accepts whitelisted chain %s", async (chain) => {
    const svc = makeSvc();
    await svc.forward({
      provider: "alchemy",
      method: "POST",
      path: chain,
      body: {},
    });
    expect(calls[0]!.url).toBe(
      `https://${chain}.g.alchemy.com/v2/alchemy-secret-xyz`
    );
  });

  it("rejects non-whitelisted chain (SSRF guard)", async () => {
    const svc = makeSvc();
    await expect(
      svc.forward({
        provider: "alchemy",
        method: "POST",
        path: "evil.example.com",
        body: {},
      })
    ).rejects.toBeInstanceOf(UpstreamProxyError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/* ------------------------- general behaviour ------------------------------- */

describe("UpstreamProxyService — general", () => {
  it("unknown provider → UpstreamProxyError with 400-ish kind", async () => {
    const svc = makeSvc();
    await expect(
      svc.forward({ provider: "evil", method: "GET", path: "anything" })
    ).rejects.toMatchObject({ name: "UpstreamProxyError", kind: "unknown_provider" });
  });

  it("does not echo Authorization header from caller (no token forwarding)", async () => {
    const svc = makeSvc();
    await svc.forward({
      provider: "debank",
      method: "GET",
      path: "v1/user/total_balance",
      query: { id: "0xabc" },
    });
    // We never set Authorization header for upstream.
    expect(calls[0]!.headers["authorization"]).toBeUndefined();
  });

  it("upstream 5xx is propagated as ProxyResponse (caller decides)", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "boom" }), { status: 503 })
    );
    const svc = makeSvc();
    const r = await svc.forward({
      provider: "debank",
      method: "GET",
      path: "v1/user/total_balance",
      query: { id: "0xabc" },
    });
    expect(r.status).toBe(503);
    expect(r.body).toContain("boom");
  });

  it("network exception → UpstreamProxyError kind=network", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("timeout"));
    const svc = makeSvc();
    await expect(
      svc.forward({
        provider: "debank",
        method: "GET",
        path: "v1/user/total_balance",
        query: { id: "0xabc" },
      })
    ).rejects.toMatchObject({ name: "UpstreamProxyError", kind: "network" });
  });
});

/* ------------------------- audit-friendly redaction ----------------------- */

describe("UpstreamProxyService — key redaction in error messages", () => {
  it("UpstreamProxyError message never contains the API key", async () => {
    fetchSpy.mockImplementation(async () => {
      throw new Error("connection refused to https://...");
    });
    const svc = makeSvc();
    try {
      await svc.forward({
        provider: "helius",
        method: "GET",
        path: "v0/addresses/X/balances",
      });
      throw new Error("expected throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain("helius-secret-xyz");
    }
  });
});
