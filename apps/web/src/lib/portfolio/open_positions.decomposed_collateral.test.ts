/**
 * GENERAL regression (artur POS-014 class, but NOT artur-specific):
 * a PROTOCOL-TOKEN collateral (GMX GLV/GM, and any `X [A-B]`-style receipt)
 * supplied to a receipt-less lending market (Morpho), which DeBank reports
 * DECOMPOSED into its underlying (WETH+USDC).
 *
 * Bug: `collateralHint` = dominant DeBank live-supply symbol = the decomposed
 * underlying (USDC). Cost-basis scoping by "USDC" never matches the registry
 * `lend_supply OUT GLV` → the GLV lots' real cost basis ($1000 here) never
 * reaches the position → near-zero startUsd (artur live: $9.96 on a $16k pos).
 *
 * Fix: when a receipt-less position's live supply is the underlying
 * decomposition of a supplied protocol token (`GLV [WETH-USDC]` → WETH+USDC),
 * scope cost basis by the PROTOCOL TOKEN, not the decomposed underlying.
 * General: works for any `SYM [A-B]` protocol-token collateral.
 */
import { describe, expect, it } from "vitest";

import { buildOpenPositions } from "./open_positions";
import { runUcbPipelineForWallet } from "./ucb_pipeline";
import type { ClassifiedOp, TokenMovement } from "./types";
import type { LiveSnapshot } from "./live";
import type { SavedWallet } from "../wallets";

const ETH = "eth";
const WALLET = "w1";
const MORPHO = { id: "eth_morphoblue", name: "Morpho Blue", category: "lending" as const };
const DEX = { id: "eth_uniswap4", name: "Uniswap V4", category: "dex" as const };

const GLV_ID = "0xdf03eed325b82bc1d4db8b49c30ecc9e05104b96";
const WETH_ID = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1";
const USDC_ID = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

function mov(s: {
  direction: "in" | "out";
  symbol: string;
  amount: number;
  usd?: number;
  tokenId?: string;
  isStable?: boolean;
  isProtocolToken?: boolean;
}): TokenMovement {
  return {
    direction: s.direction,
    symbol: s.symbol,
    amount: s.amount,
    usd: s.usd ?? null,
    tokenId: s.tokenId ?? s.symbol.toLowerCase(),
    isStable: s.isStable ?? ["USDC", "USDT", "DAI"].includes(s.symbol),
    isProtocolToken: s.isProtocolToken ?? false,
  } as TokenMovement;
}
function makeOp(o: {
  hash: string;
  type: ClassifiedOp["type"];
  time: number;
  protocol: { id: string; name: string; category: string };
  movements: Parameters<typeof mov>[0][];
}): ClassifiedOp {
  return {
    hash: o.hash,
    type: o.type,
    time: o.time,
    chain: ETH,
    status: "success",
    movement: o.movements.map(mov),
    protocol: o.protocol,
    netUsd: 0,
    gasUsd: null,
    counterparty: null,
    feePayer: null,
    fnName: null,
    approveSpender: null,
    approveSymbol: null,
    notes: [],
  } as ClassifiedOp;
}

function build() {
  const ops: ClassifiedOp[] = [
    // Acquire 500 GLV [WETH-USDC] for 1000 USDC (cost basis $1000, WAC $2/GLV).
    makeOp({ hash: "0xbuy_glv", type: "swap", time: 1000, protocol: DEX, movements: [
      { direction: "out", symbol: "USDC", amount: 1000, usd: 1000, tokenId: USDC_ID, isStable: true },
      { direction: "in", symbol: "GLV [WETH-USDC]", amount: 500, usd: 1000, tokenId: GLV_ID, isProtocolToken: true },
    ] }),
    // Supply all 500 GLV to Morpho as collateral.
    makeOp({ hash: "0xsup_glv", type: "lend_supply", time: 2000, protocol: MORPHO, movements: [
      { direction: "out", symbol: "GLV [WETH-USDC]", amount: 500, usd: 1000, tokenId: GLV_ID, isProtocolToken: true },
    ] }),
  ];

  const wallet: SavedWallet = {
    id: WALLET, name: "user", address: "0x1111111111111111111111111111111111111111",
    chain: "evm", createdAt: 1000,
  };
  // DeBank live: the GLV collateral DECOMPOSED into WETH + USDC underlying.
  const live: LiveSnapshot = {
    totalUsd: 1100, tokens: [],
    positions: [
      {
        protocolId: MORPHO.id, protocolName: MORPHO.name, chain: ETH,
        walletId: WALLET, walletName: "user", category: "lending", itemName: "Lending",
        netUsd: 1100, assetUsd: 1100, debtUsd: 0,
        supply: [
          { symbol: "WETH", amount: 0.15, usd: 600, isStable: false, tokenId: WETH_ID, isProtocolToken: false },
          { symbol: "USDC", amount: 500, usd: 500, isStable: true, tokenId: USDC_ID, isProtocolToken: false },
        ],
        borrow: [], rewards: [], lpTokenId: "0xmarketGLV", healthRate: 2.0,
      } as LiveSnapshot["positions"][number],
    ],
  };

  const pipeline = runUcbPipelineForWallet({
    walletId: WALLET, ops, annotationsByKey: new Map(),
    walletNameById: new Map([[WALLET, "user"]]),
  });
  return buildOpenPositions([{ wallet, ops, live }], {
    histPrices: new Map(),
    lotsByWallet: new Map([[WALLET, pipeline.lotTracker]]),
  });
}

describe("Decomposed protocol-token collateral (GENERAL, POS-014 class)", () => {
  const positions = build();
  const morpho = positions.find((p) => p.protocol.id === MORPHO.id);

  it("builds the Morpho position", () => {
    expect(morpho, "morpho position exists").toBeDefined();
  });

  it("startUsd = GLV cost basis ($1000), NOT near-zero (decomposed underlying)", () => {
    expect(morpho).toBeDefined();
    // The collateral's real cost = 500 GLV × $2 WAC = $1000 (NOT the $1100
    // current value, NOT ~$0). Bug: decomposed WETH+USDC ignore the GLV cost.
    expect(morpho!.startUsd).toBeGreaterThan(950);
    expect(morpho!.startUsd).toBeLessThan(1050);
  });
});
