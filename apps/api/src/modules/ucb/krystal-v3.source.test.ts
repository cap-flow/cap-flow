/**
 * B3 — KrystalV3Source: positions per wallet → summary map + per-NFT tx map.
 */
import { describe, expect, it, vi } from "vitest";

import { KrystalV3Source } from "./krystal-v3.source.js";
import type { KrystalClient } from "../integrations/krystal.js";

const NPM = "0xc36442b4a4522e871399cd717abdd847ab11fe88";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pos = (tokenId: string, deposit: number): any => ({
  chain: { id: 42161, name: "arbitrum" },
  pool: { id: "0xpool", protocol: { key: "uniswapv3" }, tokenAddresses: [] },
  ownerAddress: "0xw",
  id: `${NPM}-${tokenId}`,
  tokenId,
  currentPositionValue: 220,
  performance: { totalDepositValue: deposit },
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const depositTx = (): any => ({
  type: "DEPOSIT",
  txHash: "0xdep",
  blockTime: 1000,
  transactions: [{ token: { symbol: "WETH" }, tokenAmount: "1", amountUsd: 240 }],
});

function makeSource(
  over: {
    positionTransactions?: KrystalClient["positionTransactions"];
    closedUniswapV3Positions?: KrystalClient["closedUniswapV3Positions"];
  } = {},
) {
  const openUniswapV3Positions = vi.fn(async () => [pos("5417064", 240.83), pos("5417054", 146.86)]);
  const positionTransactions =
    over.positionTransactions ?? (vi.fn(async () => [depositTx()]) as KrystalClient["positionTransactions"]);
  const closedUniswapV3Positions =
    over.closedUniswapV3Positions ??
    (vi.fn(async () => []) as KrystalClient["closedUniswapV3Positions"]);
  const client = { openUniswapV3Positions, positionTransactions, closedUniswapV3Positions };
  const walletSource = { evmWalletsForAccount: async () => [{ address: "0xWALLET" }] };
  return {
    source: new KrystalV3Source({ client, walletSource }),
    openUniswapV3Positions,
    positionTransactions,
    closedUniswapV3Positions,
  };
}

describe("KrystalV3Source.forAccount", () => {
  it("builds krystalV3ByTokenId + krystalTxByTokenId for both NFTs", async () => {
    const { source, positionTransactions } = makeSource();
    const r = await source.forAccount("acc");
    expect([...r.krystalV3ByTokenId.keys()].sort()).toEqual(["5417054", "5417064"]);
    expect([...r.krystalTxByTokenId.keys()].sort()).toEqual(["5417054", "5417064"]);
    // per-NFT /transactions IS fetched (mandatory for the V4 trust gate)
    expect(positionTransactions).toHaveBeenCalledTimes(2);
    expect(positionTransactions).toHaveBeenCalledWith(42161, NPM, "5417064");
  });

  it("fail-soft: a per-NFT transactions throw skips that NFT, keeps the rest", async () => {
    let n = 0;
    const positionTransactions = (async () => {
      n++;
      if (n === 1) throw new Error("krystal 500");
      return [depositTx()];
    }) as KrystalClient["positionTransactions"];
    const { source } = makeSource({ positionTransactions });
    const r = await source.forAccount("acc");
    // both summaries present (positions fetched fine); one tx map entry dropped
    expect(r.krystalV3ByTokenId.size).toBe(2);
    expect(r.krystalTxByTokenId.size).toBe(1);
  });
});

describe("KrystalV3Source — CLOSED pool keys (dust-фильтр)", () => {
  it("собирает closedPoolKeys `owner|chain|pool` (lowercased) из CLOSED NFT", async () => {
    const closed = vi.fn(async (_w: string, chainId: number) =>
      chainId === 8453
        ? [{ chain: { id: 8453 }, pool: { poolAddress: "0xPOOLBASE" }, tokenId: "777" }]
        : [],
    );
    const { source } = makeSource({
      closedUniswapV3Positions: closed as unknown as KrystalClient["closedUniswapV3Positions"],
    });
    const r = await source.forAccount("acc");
    expect(r.closedPoolKeys.has("0xwallet|base|0xpoolbase")).toBe(true);
    expect(r.closedPoolKeys.size).toBe(1);
    // per-chain обход: 7 сетей × 1 адрес
    expect(closed).toHaveBeenCalledTimes(7);
  });

  it("fail-soft: throw на одной сети не валит остальные и не ломает forAccount", async () => {
    const closed = vi.fn(async (_w: string, chainId: number) => {
      if (chainId === 1) throw new Error("krystal down");
      return chainId === 42161
        ? [{ chain: { id: 42161 }, pool: { poolAddress: "0xARBPOOL" }, tokenId: "1" }]
        : [];
    });
    const { source } = makeSource({
      closedUniswapV3Positions: closed as unknown as KrystalClient["closedUniswapV3Positions"],
    });
    const r = await source.forAccount("acc");
    expect(r.closedPoolKeys.has("0xwallet|arb|0xarbpool")).toBe(true);
    expect(r.krystalV3ByTokenId.size).toBe(2);
  });
});
