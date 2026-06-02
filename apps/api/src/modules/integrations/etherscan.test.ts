/**
 * B4 — server Etherscan token-transfer fetch parsing.
 */
import { describe, expect, it, vi } from "vitest";

import {
  EtherscanChainNotSupportedError,
  EtherscanClient,
  type EtherscanProxy,
} from "./etherscan.js";

function proxyReturning(body: string, status = 200): {
  proxy: EtherscanProxy;
  forward: ReturnType<typeof vi.fn>;
} {
  const forward = vi.fn(async () => ({ status, body }));
  return { proxy: { forward } as unknown as EtherscanProxy, forward };
}

const okBody = (result: unknown) =>
  JSON.stringify({ status: "1", message: "OK", result });

describe("EtherscanClient.fetchWalletTokenTransfers", () => {
  it("maps + lowercases fields from account/tokentx(all)", async () => {
    const { proxy, forward } = proxyReturning(
      okBody([
        {
          hash: "0xAbC",
          timeStamp: "1700000000",
          blockNumber: "123",
          from: "0xWALLET",
          to: "0xVAULT",
          contractAddress: "0xUSDC",
          value: "1000000",
          tokenDecimal: "6",
          tokenSymbol: "USDC",
        },
      ]),
    );
    const client = new EtherscanClient(proxy);
    const out = await client.fetchWalletTokenTransfers("arb", "0xWALLET");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      hash: "0xAbC",
      timeStamp: 1700000000,
      blockNumber: 123,
      from: "0xwallet",
      to: "0xvault",
      contractAddress: "0xusdc",
      value: "1000000",
      tokenDecimal: 6,
      tokenSymbol: "USDC",
    });
    // chainid resolved (arb=42161), module/action/sort wired
    const req = forward.mock.calls[0]![0];
    expect(req.query).toMatchObject({
      chainid: "42161",
      module: "account",
      action: "tokentx",
      address: "0xWALLET",
      sort: "asc",
    });
  });

  it("'No transactions found' string result → []", async () => {
    const { proxy } = proxyReturning(
      JSON.stringify({ status: "0", message: "No transactions found", result: "No transactions found" }),
    );
    const out = await new EtherscanClient(proxy).fetchWalletTokenTransfers("eth", "0xw");
    expect(out).toEqual([]);
  });

  it("empty array result → []", async () => {
    const { proxy } = proxyReturning(
      JSON.stringify({ status: "0", message: "No transactions found", result: [] }),
    );
    const out = await new EtherscanClient(proxy).fetchWalletTokenTransfers("eth", "0xw");
    expect(out).toEqual([]);
  });

  it("'Free API access is not supported' → EtherscanChainNotSupportedError", async () => {
    const { proxy } = proxyReturning(
      JSON.stringify({
        status: "0",
        message: "NOTOK",
        result: "Free API access is not supported for this chain",
      }),
    );
    await expect(
      new EtherscanClient(proxy).fetchWalletTokenTransfers("base", "0xw"),
    ).rejects.toBeInstanceOf(EtherscanChainNotSupportedError);
  });

  it("non-200 → throws", async () => {
    const { proxy } = proxyReturning("upstream boom", 502);
    await expect(
      new EtherscanClient(proxy).fetchWalletTokenTransfers("eth", "0xw"),
    ).rejects.toThrow(/Etherscan HTTP 502/);
  });

  it("unknown chain → throws (no fetch)", async () => {
    const { proxy, forward } = proxyReturning(okBody([]));
    await expect(
      new EtherscanClient(proxy).fetchWalletTokenTransfers("zksync", "0xw"),
    ).rejects.toThrow(/unknown chain/);
    expect(forward).not.toHaveBeenCalled();
  });
});

describe("EtherscanClient.fetchTokenTransfers (per-contract)", () => {
  it("passes contractaddress + maps rows", async () => {
    const { proxy, forward } = proxyReturning(
      okBody([
        {
          hash: "0x1",
          timeStamp: "1760606147",
          blockNumber: "23589271",
          from: "0xVAULTMINTER",
          to: "0xWALLET",
          value: "696635",
          tokenDecimal: "8",
        },
      ]),
    );
    const out = await new EtherscanClient(proxy).fetchTokenTransfers(
      "eth",
      "0xVAULT",
      "0xWALLET",
    );
    expect(out[0]).toMatchObject({
      timeStamp: 1760606147,
      from: "0xvaultminter",
      to: "0xwallet",
      tokenDecimal: 8,
    });
    expect(forward.mock.calls[0]![0].query).toMatchObject({
      contractaddress: "0xVAULT",
      address: "0xWALLET",
    });
  });
});
