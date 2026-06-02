/**
 * B4 — server Alchemy getAssetTransfers fetch parsing (non-LP opener fallback).
 */
import { describe, expect, it, vi } from "vitest";

import {
  AlchemyTransfersClient,
  isAlchemyChainSupported,
  type AlchemyRpcProxy,
} from "./alchemy-transfers.js";

const rpcBody = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, result });

describe("isAlchemyChainSupported", () => {
  it("true for base/avax, false for unknown", () => {
    expect(isAlchemyChainSupported("base")).toBe(true);
    expect(isAlchemyChainSupported("AVAX")).toBe(true);
    expect(isAlchemyChainSupported("zksync")).toBe(false);
  });
});

describe("AlchemyTransfersClient.fetchWalletTransfers", () => {
  it("merges incoming + outgoing and decodes amount", async () => {
    const forward = vi
      .fn()
      // first call = incoming (toAddress)
      .mockResolvedValueOnce({
        status: 200,
        body: rpcBody({
          transfers: [
            {
              blockNum: "0x2a",
              hash: "0xIN",
              from: "0xZERO",
              to: "0xWALLET",
              asset: "turtleUSDC",
              rawContract: { address: "0xRECEIPT", value: "0x64", decimal: "0x0" },
            },
          ],
        }),
      })
      // second call = outgoing (fromAddress)
      .mockResolvedValueOnce({
        status: 200,
        body: rpcBody({
          transfers: [
            {
              blockNum: "0x29",
              hash: "0xOUT",
              from: "0xWALLET",
              to: "0xSTAKING",
              asset: "USDC",
              rawContract: { address: "0xUSDC", value: "0x12a05f200", decimal: "0x6" },
            },
          ],
        }),
      });
    const client = new AlchemyTransfersClient({ forward } as unknown as AlchemyRpcProxy);
    const out = await client.fetchWalletTransfers("avax", "0xWALLET");
    expect(out).toHaveLength(2);
    const inT = out.find((t) => t.hash === "0xIN")!;
    expect(inT).toMatchObject({ blockNumber: 42, to: "0xwallet", contractAddress: "0xreceipt", amount: 100 });
    const outT = out.find((t) => t.hash === "0xOUT")!;
    expect(outT.amount).toBe(5000); // 0x12a05f200 = 5_000_000_000 / 10^6
    // path = subdomain, POST
    expect(forward.mock.calls[0]![0]).toMatchObject({ provider: "alchemy", method: "POST", path: "avax-mainnet" });
  });

  it("RPC error → throws", async () => {
    const forward = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "bad params" } }),
    }));
    await expect(
      new AlchemyTransfersClient({ forward } as unknown as AlchemyRpcProxy).fetchWalletTransfers("base", "0xw"),
    ).rejects.toThrow(/bad params/);
  });
});

describe("AlchemyTransfersClient.fetchBlockTimestamps", () => {
  it("resolves unix ts per unique block", async () => {
    const forward = vi.fn(async () => ({
      status: 200,
      body: rpcBody({ timestamp: "0x60d3b8a0" }),
    }));
    const client = new AlchemyTransfersClient({ forward } as unknown as AlchemyRpcProxy);
    const out = await client.fetchBlockTimestamps("avax", [100, 100, 200]);
    expect(out.get(100)).toBe(0x60d3b8a0);
    expect(out.size).toBe(2); // deduped
    expect(forward).toHaveBeenCalledTimes(2);
  });
});
