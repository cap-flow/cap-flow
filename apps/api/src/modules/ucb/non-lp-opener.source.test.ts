/**
 * B4 slice 2b — NonLpOpenerSource: positions → nonLpOpenerByKey.
 */
import { describe, expect, it, vi } from "vitest";

import {
  NonLpOpenerSource,
  type AlchemyTransferSource,
  type NonLpOpenerDeps,
  type OpenerTargetPosition,
} from "./non-lp-opener.source.js";
import { nonLpOpenerKey } from "@cap-flow/ucb/non_lp_opener";
import { EtherscanChainNotSupportedError } from "../integrations/etherscan.js";
import type { WalletTransfer } from "@cap-flow/ucb/non_lp_opener_resolve";

const WALLET = "0x10b850c3abfca78d693c9cd6fce809c129109d1c";
const ZERO = "0x0000000000000000000000000000000000000000";
const GLV = "0xdf03eed325b82bc1d4db8b49c30ecc9e05104b96";
const GMX_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const GLV_VAULT = "0x393053b58f9678c9c28c2ce941ff6cac49c3f8f9";
const WETH = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1";
const VETH = "0x1111111111111111111111111111111111111111";

const wt = (p: Partial<WalletTransfer>): WalletTransfer => ({
  timeStamp: 1,
  blockNumber: 1,
  hash: "0xh",
  from: WALLET,
  to: "0xother",
  contractAddress: "0xtok",
  value: "0",
  tokenDecimal: 18,
  tokenSymbol: "TKN",
  ...p,
});

// POS-005: GLV async request/fill (1300 USDC → GLV minted in separate tx).
const GLV_TRANSFERS: WalletTransfer[] = [
  wt({ hash: "0x17cf", timeStamp: 1774790684, blockNumber: 446895388, from: WALLET, to: GLV_VAULT, contractAddress: GMX_USDC, value: "1300000000", tokenDecimal: 6, tokenSymbol: "USDC" }),
  wt({ hash: "0xea23", timeStamp: 1774790688, blockNumber: 446895401, from: ZERO, to: WALLET, contractAddress: GLV, value: "1016578616393671586567", tokenDecimal: 18, tokenSymbol: "GLV [WBTC-USDC]" }),
];

function deps(over: Partial<NonLpOpenerDeps> = {}): NonLpOpenerDeps {
  return {
    etherscan: {
      fetchWalletTokenTransfers: vi.fn(async () => GLV_TRANSFERS),
    },
    fetchHistoricalPrices: vi.fn(async () => new Map<string, number>()),
    ...over,
  };
}

const pos = (p: Partial<OpenerTargetPosition>): OpenerTargetPosition => ({
  protocol: { name: "GMX V2" },
  lpTokenId: GLV,
  chain: "arb",
  walletId: "w1",
  ...p,
});

const byId = new Map([["w1", WALLET]]);

describe("NonLpOpenerSource.forPositions", () => {
  it("POS-005 GLV async: OUT-side $1300 keyed by nonLpOpenerKey", async () => {
    const src = new NonLpOpenerSource(deps());
    const map = await src.forPositions([pos({})], byId);
    const key = nonLpOpenerKey("arb", GLV, WALLET);
    const op = map.get(key)!;
    expect(op).toBeDefined();
    expect(op.openedAt).toBe(1774790688);
    expect(op.openedInTokens).toEqual([
      { address: GMX_USDC, symbol: "USDC", amount: 1300 },
    ]);
    expect(op.startUsd).toBe(1300);
  });

  it("skips V3-LP, missing lpTokenId, missing wallet address", async () => {
    const fetchWalletTokenTransfers = vi.fn(async () => GLV_TRANSFERS);
    const src = new NonLpOpenerSource(deps({ etherscan: { fetchWalletTokenTransfers } }));
    const map = await src.forPositions(
      [
        pos({ protocol: { name: "Uniswap V3" } }), // V3-LP → skip
        pos({ lpTokenId: null }), // no receipt → skip
        pos({ walletId: "unknown" }), // no wallet addr → skip
      ],
      byId,
    );
    expect(map.size).toBe(0);
    expect(fetchWalletTokenTransfers).not.toHaveBeenCalled();
  });

  it("groups multiple receipt tokens of one wallet-chain into ONE fetch", async () => {
    const fetchWalletTokenTransfers = vi.fn(async () => GLV_TRANSFERS);
    const src = new NonLpOpenerSource(deps({ etherscan: { fetchWalletTokenTransfers } }));
    await src.forPositions(
      [pos({ lpTokenId: GLV }), pos({ lpTokenId: GLV_VAULT })],
      byId,
    );
    expect(fetchWalletTokenTransfers).toHaveBeenCalledTimes(1);
  });

  it("fail-soft per group: one wallet-chain throws, others still resolve", async () => {
    const fetchWalletTokenTransfers = vi.fn(async (chain: string) => {
      if (chain === "op") throw new Error("etherscan 500");
      return GLV_TRANSFERS;
    });
    const src = new NonLpOpenerSource(deps({ etherscan: { fetchWalletTokenTransfers } }));
    const map = await src.forPositions(
      [pos({ chain: "arb" }), pos({ chain: "op" })],
      byId,
    );
    // arb resolved, op dropped
    expect(map.has(nonLpOpenerKey("arb", GLV, WALLET))).toBe(true);
    expect(map.has(nonLpOpenerKey("op", GLV, WALLET))).toBe(false);
  });

  it("Alchemy fallback when Etherscan free unsupported (BASE)", async () => {
    const fetchWalletTokenTransfers = vi.fn(async () => {
      throw new EtherscanChainNotSupportedError("base");
    });
    const alchemy: AlchemyTransferSource = {
      fetchWalletTransfers: vi.fn(async () => [
        { blockNumber: 700, hash: "0xdep", from: WALLET, to: "0xstk", contractAddress: GMX_USDC, amount: 310, symbol: "USDC" },
      ]),
      fetchBlockTimestamps: vi.fn(async () => new Map([[700, 1700001234]])),
    };
    const STK = "0xstk";
    const src = new NonLpOpenerSource(
      deps({ etherscan: { fetchWalletTokenTransfers }, alchemy }),
    );
    const map = await src.forPositions([pos({ chain: "base", lpTokenId: STK })], byId);
    const op = map.get(nonLpOpenerKey("base", STK, WALLET))!;
    expect(op.openedAt).toBe(1700001234);
    expect(op.startUsd).toBe(310);
  });

  it("volatile OUT (WETH) priced via DefiLlama historical", async () => {
    const transfers: WalletTransfer[] = [
      wt({ hash: "0xdep", timeStamp: 1700000000, blockNumber: 5, from: WALLET, to: "0xvault", contractAddress: WETH, value: "1000000000000000000", tokenDecimal: 18, tokenSymbol: "WETH" }),
      wt({ hash: "0xdep", timeStamp: 1700000000, blockNumber: 5, from: ZERO, to: WALLET, contractAddress: VETH, value: "1000000000000000000", tokenDecimal: 18, tokenSymbol: "vETH" }),
    ];
    // DefiLlama returns ETH @ $2500 at the deposit bucket.
    const fetchHistoricalPrices = vi.fn(async () => {
      const bucket = Math.floor(1700000000 / 3600) * 3600;
      return new Map([[`arbitrum:${WETH}|${bucket}`, 2500]]);
    });
    const src = new NonLpOpenerSource(
      deps({
        etherscan: { fetchWalletTokenTransfers: vi.fn(async () => transfers) },
        fetchHistoricalPrices,
      }),
    );
    const map = await src.forPositions([pos({ lpTokenId: VETH })], byId);
    const op = map.get(nonLpOpenerKey("arb", VETH, WALLET))!;
    expect(op.startUsd).toBe(2500); // 1 WETH × $2500
    expect(fetchHistoricalPrices).toHaveBeenCalled();
  });
});
