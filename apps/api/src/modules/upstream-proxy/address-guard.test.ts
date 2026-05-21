import { describe, expect, it } from "vitest";

import {
  buildOwnedSet,
  decide,
  extractAddresses,
  type ProxyRequestForGuard,
} from "./address-guard.js";

const OWN_EVM = "0x1111111111111111111111111111111111111111";
const OTHER_EVM = "0x2222222222222222222222222222222222222222";
const OWN_SOL = "So11111111111111111111111111111111111111112";
const OTHER_SOL = "FZJgr1H8RPdAcW7HCSrGFhpvDh5fzwYjJv9XJgQ3sQXC";

const owned = buildOwnedSet([
  { address: OWN_EVM, type: "evm" },
  { address: OWN_SOL, type: "solana" },
]);

function req(p: Partial<ProxyRequestForGuard>): ProxyRequestForGuard {
  return {
    provider: p.provider ?? "debank",
    method: p.method ?? "GET",
    path: p.path ?? "v1/user/total_balance",
    query: p.query ?? {},
    body: p.body,
  };
}

describe("address-guard — DeBank extraction", () => {
  it("finds address in query.id", () => {
    const r = extractAddresses(
      req({ provider: "debank", query: { id: OWN_EVM } })
    );
    expect(r.invalid).toHaveLength(0);
    expect(r.addresses).toHaveLength(1);
    expect(r.addresses[0]!.normalized).toBe(OWN_EVM.toLowerCase());
  });

  it("normalises EVM to lowercase", () => {
    const mixed = "0xAaBb" + OWN_EVM.slice(6);
    const r = extractAddresses(
      req({ provider: "debank", query: { id: mixed } })
    );
    expect(r.addresses[0]!.normalized).toBe(mixed.toLowerCase());
  });

  it("flags malformed hex (wrong length)", () => {
    const r = extractAddresses(
      req({ provider: "debank", query: { id: "0xdeadbeef" } })
    );
    expect(r.invalid.length).toBeGreaterThan(0);
  });

  it("ignores endpoint with no address slot", () => {
    const r = extractAddresses(
      req({ provider: "debank", path: "v1/chain/list", query: {} })
    );
    expect(r.addresses).toHaveLength(0);
    expect(r.invalid).toHaveLength(0);
  });
});

describe("address-guard — Helius extraction", () => {
  it("finds address in path segment", () => {
    const r = extractAddresses(
      req({
        provider: "helius",
        path: `v0/addresses/${OWN_SOL}/balances`,
        query: {},
      })
    );
    expect(r.addresses).toHaveLength(1);
    expect(r.addresses[0]!.normalized).toBe(OWN_SOL);
  });

  it("finds addresses in body.accounts (POST)", () => {
    const r = extractAddresses(
      req({
        provider: "helius",
        method: "POST",
        path: "v0/transactions",
        body: { accounts: [OWN_SOL, OTHER_SOL] },
      })
    );
    expect(r.addresses).toHaveLength(2);
  });
});

describe("address-guard — Etherscan extraction", () => {
  it("finds address in query.address", () => {
    const r = extractAddresses(
      req({ provider: "etherscan", path: "v2/api", query: { address: OWN_EVM } })
    );
    expect(r.addresses).toHaveLength(1);
  });

  it("handles CSV (balancemulti)", () => {
    const r = extractAddresses(
      req({
        provider: "etherscan",
        path: "v2/api",
        query: { address: `${OWN_EVM},${OTHER_EVM}` },
      })
    );
    expect(r.addresses).toHaveLength(2);
  });
});

describe("address-guard — Alchemy extraction", () => {
  it("finds address in params[0] of eth_getBalance", () => {
    const r = extractAddresses(
      req({
        provider: "alchemy",
        method: "POST",
        path: "eth-mainnet",
        body: {
          jsonrpc: "2.0",
          method: "eth_getBalance",
          params: [OWN_EVM, "latest"],
          id: 1,
        },
      })
    );
    expect(r.addresses.map((a) => a.normalized)).toContain(OWN_EVM.toLowerCase());
  });

  it("finds from/to in alchemy_getAssetTransfers", () => {
    const r = extractAddresses(
      req({
        provider: "alchemy",
        method: "POST",
        path: "eth-mainnet",
        body: {
          jsonrpc: "2.0",
          method: "alchemy_getAssetTransfers",
          params: [{ fromAddress: OWN_EVM, toAddress: OTHER_EVM }],
          id: 1,
        },
      })
    );
    expect(r.addresses.map((a) => a.normalized).sort()).toEqual(
      [OWN_EVM.toLowerCase(), OTHER_EVM.toLowerCase()].sort()
    );
  });

  it("handles JSON-RPC batch arrays", () => {
    const r = extractAddresses(
      req({
        provider: "alchemy",
        method: "POST",
        path: "eth-mainnet",
        body: [
          { jsonrpc: "2.0", method: "eth_getBalance", params: [OWN_EVM, "latest"], id: 1 },
          { jsonrpc: "2.0", method: "eth_getBalance", params: [OTHER_EVM, "latest"], id: 2 },
        ],
      })
    );
    expect(r.addresses).toHaveLength(2);
  });

  it("eth_getTransactionReceipt(txHash) — НЕ flag'нуть tx hash как malformed", () => {
    // V3 pool-resolver (P1) фетчит receipt'ы для каждого V3 lp_add op.
    // Раньше address-guard.looksLikeAddrAttempt видел `0x` + 66 chars и
    // помечал как malformed → 400 → broken pool matching → orphan NFT bug.
    const txHash =
      "0xa4b7940802fa46b801102989ed5d363beb1579004893c680ce3e5234db7ec3c9";
    const r = extractAddresses(
      req({
        provider: "alchemy",
        method: "POST",
        path: "eth-mainnet",
        body: [
          {
            jsonrpc: "2.0",
            method: "eth_getTransactionReceipt",
            params: [txHash],
            id: 1,
          },
        ],
      }),
    );
    expect(r.addresses).toHaveLength(0);
    expect(r.invalid).toHaveLength(0);
  });

  it("eth_call с block tag в params[1] — block hex НЕ flag'нуть", () => {
    // V3 hist-price hook делает eth_call({to: pool, data: 0x3850c7bd}, "0x17de95d")
    // чтобы fetch'нуть slot0() на конкретном block height. Block tag
    // params[1] не должен превращаться в malformed address — раньше
    // он flag'ировался потому что `0x17de95d` ≠ 42-char address.
    const r = extractAddresses(
      req({
        provider: "alchemy",
        method: "POST",
        path: "eth-mainnet",
        body: {
          jsonrpc: "2.0",
          method: "eth_call",
          params: [
            { to: "0xb431c70f800100d87554ac1142c4a94c5fe4c0c4", data: "0x3850c7bd" },
            "0x17de95d", // block number hex
          ],
          id: 1,
        },
      }),
    );
    // `to` field is in NON_USER_KEYS (skipped), params[1] is block tag
    // (skipped in handleRpcCall). 0 addresses extracted, 0 invalid.
    expect(r.addresses).toHaveLength(0);
    expect(r.invalid).toHaveLength(0);
  });

  it("decide() для eth_getTransactionReceipt → allow", () => {
    const txHash =
      "0xa4b7940802fa46b801102989ed5d363beb1579004893c680ce3e5234db7ec3c9";
    const d = decide(
      req({
        provider: "alchemy",
        method: "POST",
        path: "eth-mainnet",
        body: [
          {
            jsonrpc: "2.0",
            method: "eth_getTransactionReceipt",
            params: [txHash],
            id: 1,
          },
        ],
      }),
      owned,
      { isAdmin: false },
    );
    expect(d.kind).toBe("allow");
  });
});

describe("address-guard — decide()", () => {
  it("(a) own address → allow", () => {
    const d = decide(
      req({ provider: "debank", query: { id: OWN_EVM } }),
      owned,
      { isAdmin: false }
    );
    expect(d.kind).toBe("allow");
  });

  it("(b) other user's address → forbidden", () => {
    const d = decide(
      req({ provider: "debank", query: { id: OTHER_EVM } }),
      owned,
      { isAdmin: false }
    );
    expect(d.kind).toBe("forbidden");
  });

  it("(c) admin → allow regardless", () => {
    const d = decide(
      req({ provider: "debank", query: { id: OTHER_EVM } }),
      owned,
      { isAdmin: true }
    );
    expect(d.kind).toBe("allow");
  });

  it("(d) malformed address → malformed", () => {
    const d = decide(
      req({ provider: "debank", query: { id: "0xdeadbeef" } }),
      owned,
      { isAdmin: false }
    );
    expect(d.kind).toBe("malformed");
  });

  it("partial ownership in batch → forbidden", () => {
    // alchemy batch with one own + one not-own → still rejected.
    const d = decide(
      req({
        provider: "alchemy",
        method: "POST",
        path: "eth-mainnet",
        body: [
          { jsonrpc: "2.0", method: "eth_getBalance", params: [OWN_EVM, "latest"], id: 1 },
          { jsonrpc: "2.0", method: "eth_getBalance", params: [OTHER_EVM, "latest"], id: 2 },
        ],
      }),
      owned,
      { isAdmin: false }
    );
    expect(d.kind).toBe("forbidden");
  });

  it("no addresses in request → allow (provider allow-list still applies)", () => {
    const d = decide(
      req({ provider: "debank", path: "v1/chain/list", query: {} }),
      owned,
      { isAdmin: false }
    );
    expect(d.kind).toBe("allow");
  });

  it("EVM checksum case is ownership-equivalent", () => {
    const checksummed =
      "0x1111111111111111111111111111111111111111".replace(/1/g, (c, i) =>
        i % 2 ? c.toUpperCase() : c
      );
    const d = decide(
      req({ provider: "debank", query: { id: checksummed } }),
      owned,
      { isAdmin: false }
    );
    expect(d.kind).toBe("allow");
  });

  it("unknown provider → malformed (fail closed)", () => {
    const d = decide(
      req({ provider: "rugpullscan", query: {} }),
      owned,
      { isAdmin: false }
    );
    expect(d.kind).toBe("malformed");
  });
});
