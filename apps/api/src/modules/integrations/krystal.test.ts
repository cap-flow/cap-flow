/**
 * B3 — server Krystal client over a stubbed proxy (no network).
 */
import { describe, expect, it, vi } from "vitest";

import { KrystalClient, type KrystalProxy } from "./krystal.js";

function proxyReturning(status: number, body: string) {
  const forward = vi.fn(async () => ({ status, body }));
  return { proxy: { forward } as KrystalProxy, forward };
}

describe("KrystalClient", () => {
  it("openUniswapV3Positions: forwards the right path/query + parses 200", async () => {
    const sample = [{ tokenId: "5417064", id: "0xnpm-5417064", currentPositionValue: 219 }];
    const { proxy, forward } = proxyReturning(200, JSON.stringify(sample));
    const out = await new KrystalClient(proxy).openUniswapV3Positions("0xWALLET");
    expect(out).toHaveLength(1);
    expect(out[0]!.tokenId).toBe("5417064");
    expect(forward).toHaveBeenCalledWith({
      provider: "krystal",
      method: "GET",
      path: "v1/positions",
      query: { wallet: "0xWALLET", positionStatus: "OPEN", protocols: "uniswap" },
    });
  });

  it("openUniswapV3Positions: non-200 → [] (fail-soft, e.g. 402 out-of-credits)", async () => {
    const { proxy } = proxyReturning(402, "out of credits");
    expect(await new KrystalClient(proxy).openUniswapV3Positions("0xW")).toEqual([]);
  });

  it("openUniswapV3Positions: malformed body → []", async () => {
    const { proxy } = proxyReturning(200, "not json");
    expect(await new KrystalClient(proxy).openUniswapV3Positions("0xW")).toEqual([]);
  });

  it("positionTransactions: builds {chainId}/{npm}-{tokenId}/transactions path", async () => {
    const { proxy, forward } = proxyReturning(200, JSON.stringify([{ type: "DEPOSIT" }]));
    const out = await new KrystalClient(proxy).positionTransactions(
      42161,
      "0xc36442b4a4522e871399cd717abdd847ab11fe88",
      "5417064",
    );
    expect(out).toHaveLength(1);
    expect(forward).toHaveBeenCalledWith({
      provider: "krystal",
      method: "GET",
      path: "v1/positions/42161/0xc36442b4a4522e871399cd717abdd847ab11fe88-5417064/transactions",
    });
  });

  it("positionTransactions: 404 (no txs) → []", async () => {
    const { proxy } = proxyReturning(404, "");
    expect(
      await new KrystalClient(proxy).positionTransactions(1, "0xnpm", "1"),
    ).toEqual([]);
  });
});
