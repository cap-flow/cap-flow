/**
 * Regression (testakk 1s, POS-004): Morpho Blue — несколько РАЗНЫХ рынков
 * на одном кошельке (wSPYx / PT-apxUSD / PT-apyUSD коллатерали). Каждый рынок
 * = отдельная позиция со СВОИМ залогом, долгом и HF.
 *
 * Баг: Morpho receipt-less → `buildOne` пропускал per-market scoping (lpTokenId
 * у Morpho = singleton-контракт, не совпадает с движениями) → `openedInTokens`
 * («Внесено») каждой позиции тянул залоги ВСЕХ рынков. Конкретно: PT-токены
 * (`isProtocolToken=true`) перехватывались Pass 1, а wSPYx (non-proto) не
 * доходил до Pass 3 → у SPYx-позиции «Внесено» = PT-apxUSD + PT-apyUSD.
 *
 * Также: on-chain символ `wSPYx` ≠ DeBank-состав `SPYx` (wrapped-aliasing) —
 * матчинг залога должен канонизировать wSPYx→SPYx (решение owner 2026-05-31).
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
const UNIV4 = { id: "eth_uniswap4", name: "Uniswap V4", category: "dex" as const };
const PENDLE = { id: "eth_pendle2", name: "Pendle V2", category: "yield" as const };

const SPYX_ID = "0xc88fcd8b874fdb3256e8b55b3decb8c24eab4c02"; // wSPYx
const PTAPX_ID = "0x92a6a01b0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e";
const PTAPY_ID = "0x3365554a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a";
const USDC_ID = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

interface MovSpec {
  direction: "in" | "out";
  symbol: string;
  amount: number;
  usd?: number;
  tokenId?: string;
  isStable?: boolean;
  isProtocolToken?: boolean;
}
function mov(s: MovSpec): TokenMovement {
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
  movements: MovSpec[];
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

function lendPos(args: {
  collateral: MovSpec & { amount: number };
  debtSym: string;
  debtUsd: number;
  lpTokenId: string;
}): LiveSnapshot["positions"][number] {
  return {
    protocolId: MORPHO.id,
    protocolName: MORPHO.name,
    chain: ETH,
    walletId: WALLET,
    walletName: "testakk 1s",
    category: "lending",
    itemName: "Lending",
    netUsd: (args.collateral.usd ?? 0) - args.debtUsd,
    assetUsd: args.collateral.usd ?? 0,
    debtUsd: args.debtUsd,
    supply: [
      {
        symbol: args.collateral.symbol,
        amount: args.collateral.amount,
        usd: args.collateral.usd ?? 0,
        isStable: false,
        tokenId: args.collateral.tokenId ?? args.collateral.symbol.toLowerCase(),
        isProtocolToken: args.collateral.isProtocolToken ?? false,
      },
    ],
    borrow: [
      { symbol: args.debtSym, amount: args.debtUsd, usd: args.debtUsd, isStable: true, isProtocolToken: false },
    ],
    rewards: [],
    lpTokenId: args.lpTokenId,
    healthRate: 1.8,
  } as LiveSnapshot["positions"][number];
}

function build() {
  const ops: ClassifiedOp[] = [
    // ── wSPYx market: acquire via Uni V4 swap, supply to Morpho ──
    makeOp({ hash: "0xacq_spyx", type: "swap", time: 1000, protocol: UNIV4, movements: [
      { direction: "out", symbol: "USDC", amount: 1178.46, usd: 1178.46, tokenId: USDC_ID, isStable: true },
      { direction: "in", symbol: "wSPYx", amount: 1.5398, usd: 1178.46, tokenId: SPYX_ID },
    ] }),
    makeOp({ hash: "0xsup_spyx", type: "lend_supply", time: 1100, protocol: MORPHO, movements: [
      { direction: "out", symbol: "wSPYx", amount: 1.5398, usd: 1178.46, tokenId: SPYX_ID },
    ] }),
    // ── PT-apxUSD market: acquire via Pendle (PT isProtocolToken), supply ──
    makeOp({ hash: "0xacq_apx", type: "lp_add", time: 2000, protocol: PENDLE, movements: [
      { direction: "out", symbol: "USDC", amount: 1418.67, usd: 1418.67, tokenId: USDC_ID, isStable: true },
      { direction: "in", symbol: "PT-apxUSD-18JUN2026", amount: 1427.31, usd: 1418.67, tokenId: PTAPX_ID, isProtocolToken: true },
    ] }),
    makeOp({ hash: "0xsup_apx", type: "lend_supply", time: 2100, protocol: MORPHO, movements: [
      { direction: "out", symbol: "PT-apxUSD-18JUN2026", amount: 1427.31, usd: 1418.67, tokenId: PTAPX_ID, isProtocolToken: true },
    ] }),
    // ── PT-apyUSD market: acquire via Pendle, supply ──
    makeOp({ hash: "0xacq_apy", type: "lp_add", time: 3000, protocol: PENDLE, movements: [
      { direction: "out", symbol: "USDC", amount: 3493.85, usd: 3493.85, tokenId: USDC_ID, isStable: true },
      { direction: "in", symbol: "PT-apyUSD-18JUN2026", amount: 3527.61, usd: 3493.85, tokenId: PTAPY_ID, isProtocolToken: true },
    ] }),
    makeOp({ hash: "0xsup_apy", type: "lend_supply", time: 3100, protocol: MORPHO, movements: [
      { direction: "out", symbol: "PT-apyUSD-18JUN2026", amount: 3527.61, usd: 3493.85, tokenId: PTAPY_ID, isProtocolToken: true },
    ] }),
  ];

  const wallet: SavedWallet = {
    id: WALLET, name: "testakk 1s",
    address: "0xcad07a3c7de7eeaed84e22bc75caf7529778a825",
    chain: "evm", createdAt: 1000,
  };
  const live: LiveSnapshot = {
    totalUsd: 6090.98,
    tokens: [],
    positions: [
      lendPos({ collateral: { direction: "out", symbol: "SPYx", amount: 1.544247, usd: 1178.46, tokenId: SPYX_ID }, debtSym: "AUSD", debtUsd: 815, lpTokenId: "0xmarketSPYx" }),
      lendPos({ collateral: { direction: "out", symbol: "PT-apxUSD-18JUN2026", amount: 1427.31, usd: 1418.67, tokenId: PTAPX_ID, isProtocolToken: true }, debtSym: "USDC", debtUsd: 1000, lpTokenId: "0xmarketAPX" }),
      lendPos({ collateral: { direction: "out", symbol: "PT-apyUSD-18JUN2026", amount: 3527.61, usd: 3493.85, tokenId: PTAPY_ID, isProtocolToken: true }, debtSym: "USDC", debtUsd: 2500, lpTokenId: "0xmarketAPY" }),
    ],
  };

  const pipeline = runUcbPipelineForWallet({
    walletId: WALLET, ops,
    annotationsByKey: new Map(),
    walletNameById: new Map([[WALLET, "testakk 1s"]]),
  });
  return buildOpenPositions([{ wallet, ops, live }], {
    histPrices: new Map(),
    lotsByWallet: new Map([[WALLET, pipeline.lotTracker]]),
  });
}

const canon = (s: string) => s.toUpperCase().replace(/^W(?=[A-Z])/, "");

describe("Morpho multi-market: каждая позиция несёт ТОЛЬКО свой залог (POS-004)", () => {
  const positions = build();
  const bySupply = (frag: string) =>
    positions.find(
      (p) =>
        p.protocol.id === MORPHO.id &&
        p.supplyTokens.some((t) => t.symbol.toUpperCase().includes(frag.toUpperCase())),
    );

  it("строит 3 отдельные Morpho-позиции", () => {
    const morpho = positions.filter((p) => p.protocol.id === MORPHO.id);
    expect(morpho).toHaveLength(3);
  });

  it("SPYx-позиция: «Внесено» = только SPYx (НЕ PT-apx/apy)", () => {
    const p = bySupply("SPYx")!;
    expect(p, "SPYx position exists").toBeDefined();
    const syms = p.openedInTokens.map((t) => t.symbol);
    expect(syms.some((s) => canon(s) === "SPYX")).toBe(true);
    expect(syms.some((s) => /^PT-/i.test(s))).toBe(false);
  });

  it("PT-apxUSD-позиция: «Внесено» = только PT-apxUSD", () => {
    const p = bySupply("PT-apxUSD")!;
    const syms = p.openedInTokens.map((t) => t.symbol.toUpperCase());
    expect(syms).toContain("PT-APXUSD-18JUN2026");
    expect(syms.some((s) => /apyusd|spyx/i.test(s))).toBe(false);
  });

  it("PT-apyUSD-позиция: «Внесено» = только PT-apyUSD", () => {
    const p = bySupply("PT-apyUSD")!;
    const syms = p.openedInTokens.map((t) => t.symbol.toUpperCase());
    expect(syms).toContain("PT-APYUSD-18JUN2026");
    expect(syms.some((s) => /apxusd|spyx/i.test(s))).toBe(false);
  });
});
