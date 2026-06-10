/**
 * Integration: GMX V2 partial-withdraw rebalance — owner methodology (locked
 * 2026-06-10, testakk/Artur 0x70d9 flow от 2026-06-09).
 *
 * Методика (подтверждена owner'ом на конкретных числах):
 *   1. Покупка GM: цена = уплаченный стейбл (номинал) / полученные GM —
 *      по КОНКРЕТНОМУ GM-токену (рынки не смешиваются).
 *   2. Продажа (lp_remove): списание по WAC, действующей НА МОМЕНТ продажи
 *      (последовательная WAC: пересчёт после каждой покупки).
 *   3. Ноги вывода: стейбл забирает свою долю ПО НОМИНАЛУ, весь остаток
 *      списанной базы ложится на волатильную ногу:
 *        (3 090 GM × $1.7472874114 − 2 308.038775 USDC) / 1.406037 WETH
 *        = $2 198.43/WETH.
 *   4. Унаследованная цена ноги уезжает дальше (Fluid supply).
 *
 * Контрольные числа (verified против реестра операций Artur):
 *   buy  5 150.841208 GM за $9 000        → $1.7472874114/GM
 *   sell 3 090 GM → списано $5 399.12; нога 1.406037 WETH ← $3 091.08
 *   buy  1 527.239336 GM за $2 308.038775 → итог 3 588.080544 GM, $5 908.92
 *   Fluid supply 1.406037 ETH → startUsd $3 091.08 (НЕ market $2 304)
 *
 * Анти-таргеты (как НЕЛЬЗЯ):
 *   - gross×netFraction «задним числом» → $6 075.55 (нарушает сохранение
 *     денег на $166.80)
 *   - нога по market price на момент вывода → $2 304 (теряет унаследованный
 *     убыток GM)
 */
import { describe, expect, it } from "vitest";

import { runUcbPipelineForWallet } from "./ucb_pipeline";
import type { ClassifiedOp, TokenMovement } from "./types";

const ARB = "arb";
const WALLET = "w1";
const GMX = { id: "arb_gmx2", name: "GMX V2", category: "yield" as const };
const FLUID = { id: "arb_fluid", name: "Fluid", category: "lending" as const };

const GM1 = "0x70d95587d40a2caf56bd97485ab3eec10bee6336"; // WETH/USDC market
const GM2 = "0x47c031236e19d024b42f8ae6780e44a573170703"; // WBTC/USDC market
const WETH = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1";
const USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";

interface MovementSpec {
  direction: "in" | "out";
  symbol: string;
  amount: number;
  usd?: number;
  tokenId?: string;
  isStable?: boolean;
  isProtocolToken?: boolean;
}

function mov(spec: MovementSpec): TokenMovement {
  return {
    direction: spec.direction,
    symbol: spec.symbol,
    amount: spec.amount,
    usd: spec.usd ?? null,
    tokenId: spec.tokenId ?? spec.symbol.toLowerCase(),
    isStable: spec.isStable ?? ["USDC", "USDT", "DAI"].includes(spec.symbol),
    isProtocolToken: spec.isProtocolToken ?? false,
  } as TokenMovement;
}

interface OpSpec {
  hash: string;
  type: ClassifiedOp["type"];
  time: number;
  protocol?: { id: string; name: string; category: string } | null;
  movements: MovementSpec[];
  notes?: string[];
  linkedCostBasisUsd?: number;
  linkedHash?: string;
  /** Линкер в проде проставляет рынок на ОБЕ стороны пары. */
  linkedLpTokenId?: string;
}

function makeOp(spec: OpSpec): ClassifiedOp {
  const op = {
    hash: spec.hash,
    type: spec.type,
    time: spec.time,
    chain: ARB,
    status: "success",
    movement: spec.movements.map(mov),
    protocol: spec.protocol ?? null,
    netUsd: 0,
    gasUsd: null,
    counterparty: null,
    feePayer: null,
    fnName: null,
    approveSpender: null,
    approveSymbol: null,
    notes: spec.notes ?? [],
  } as ClassifiedOp;
  if (spec.linkedCostBasisUsd != null) {
    (op as { linkedCostBasisUsd?: number }).linkedCostBasisUsd =
      spec.linkedCostBasisUsd;
  }
  if (spec.linkedHash != null) {
    (op as { linkedHash?: string }).linkedHash = spec.linkedHash;
  }
  if (spec.linkedLpTokenId != null) {
    (op as { linkedLpTokenId?: string; linkedLpSymbol?: string }).linkedLpTokenId =
      spec.linkedLpTokenId;
    (op as { linkedLpSymbol?: string }).linkedLpSymbol = "GM";
  }
  return op;
}

/** Полный фикстур вчерашнего ребаланса 0x70d9 (+ контрольный рынок GM2). */
function rebalanceOps(): ClassifiedOp[] {
  return [
    // ── BUY №1: 9 000 USDC → 5 150.841208 GM@GM1 (async pair) ──
    makeOp({
      hash: "0xa1-request",
      type: "lp_add",
      time: 1_000_000,
      protocol: GMX,
      notes: ["yield-deposit"],
      linkedHash: "0xb1-fill",
      linkedLpTokenId: GM1,
      movements: [
        { direction: "out", symbol: "USDC", amount: 9000, usd: 9005.4, tokenId: USDC, isStable: true },
      ],
    }),
    makeOp({
      hash: "0xb1-fill",
      type: "lp_add",
      time: 1_000_003,
      protocol: GMX,
      notes: ["yield-deposit-fill"],
      linkedHash: "0xa1-request",
      linkedLpTokenId: GM1,
      linkedCostBasisUsd: 9000,
      movements: [
        { direction: "in", symbol: "GM", amount: 5150.841208, usd: 9000, tokenId: GM1, isProtocolToken: true },
      ],
    }),
    // ── Контрольный рынок GM2: 5 000 USDC → 2 225.162927 GM@GM2 ──
    makeOp({
      hash: "0xa1b-request",
      type: "lp_add",
      time: 1_050_000,
      protocol: GMX,
      notes: ["yield-deposit"],
      linkedHash: "0xb1b-fill",
      linkedLpTokenId: GM2,
      movements: [
        { direction: "out", symbol: "USDC", amount: 5000, usd: 5000, tokenId: USDC, isStable: true },
      ],
    }),
    makeOp({
      hash: "0xb1b-fill",
      type: "lp_add",
      time: 1_050_003,
      protocol: GMX,
      notes: ["yield-deposit-fill"],
      linkedHash: "0xa1b-request",
      linkedLpTokenId: GM2,
      linkedCostBasisUsd: 5000,
      movements: [
        { direction: "in", symbol: "GM", amount: 2225.162927, usd: 5000, tokenId: GM2, isProtocolToken: true },
      ],
    }),
    // ── SELL: burn 3 090 GM@GM1 (Tx A) → ноги в Tx B ──
    makeOp({
      hash: "0xa2-burn",
      type: "lp_remove",
      time: 2_000_000,
      protocol: GMX,
      linkedHash: "0xb2-legs",
      linkedLpTokenId: GM1,
      movements: [
        { direction: "out", symbol: "GM", amount: 3090, usd: 4619.62, tokenId: GM1, isProtocolToken: true },
      ],
    }),
    makeOp({
      hash: "0xb2-legs",
      type: "lp_remove",
      time: 2_000_005,
      protocol: GMX,
      linkedHash: "0xa2-burn",
      linkedLpTokenId: GM1,
      movements: [
        { direction: "in", symbol: "USDC", amount: 2308.038775, usd: 2308.96, tokenId: USDC, isStable: true },
        { direction: "in", symbol: "WETH", amount: 1.406037, usd: 2304.37, tokenId: WETH },
      ],
    }),
    // ── BUY №2 (ре-депозит стейбла): 2 308.038775 USDC → 1 527.239336 GM@GM1 ──
    makeOp({
      hash: "0xa3-request",
      type: "lp_add",
      time: 2_100_000,
      protocol: GMX,
      notes: ["yield-deposit"],
      linkedHash: "0xb3-fill",
      linkedLpTokenId: GM1,
      movements: [
        { direction: "out", symbol: "USDC", amount: 2308.038775, usd: 2308.96, tokenId: USDC, isStable: true },
      ],
    }),
    makeOp({
      hash: "0xb3-fill",
      type: "lp_add",
      time: 2_100_003,
      protocol: GMX,
      notes: ["yield-deposit-fill"],
      linkedHash: "0xa3-request",
      linkedLpTokenId: GM1,
      linkedCostBasisUsd: 2308.038775,
      movements: [
        { direction: "in", symbol: "GM", amount: 1527.239336, usd: 2283.26, tokenId: GM1, isProtocolToken: true },
      ],
    }),
    // ── Волатильная нога уезжает во Fluid ──
    makeOp({
      hash: "0xfluid-supply",
      type: "lend_supply",
      time: 2_200_000,
      protocol: FLUID,
      movements: [
        // native ETH (unwrap WETH→ETH — один канонический пул)
        { direction: "out", symbol: "ETH", amount: 1.406037, usd: 2304.37, tokenId: "arb" },
      ],
    }),
  ];
}

describe("GMX rebalance — owner methodology 2026-06-10 (testakk 0x70d9)", () => {
  it("нога вывода наследует базу GM (стейбл по номиналу, остаток в ногу) → Fluid startUsd = $3 091.08", () => {
    const result = runUcbPipelineForWallet({
      walletId: WALLET,
      ops: rebalanceOps(),
      annotationsByKey: new Map(),
      walletNameById: new Map([[WALLET, "Artur Test"]]),
    });

    const fluid = result
      .positionTracker!.all()
      .filter((p) => p.walletId === WALLET && p.protocolId === "arb_fluid");
    expect(fluid.length).toBeGreaterThan(0);
    const totalFluidCost = fluid.reduce((s, p) => s + p.currentCostBasisUsd, 0);
    // (3 090 × 1.7472874114 − 2 308.038775) = $3 091.08 — НЕ market $2 304.37
    expect(totalFluidCost).toBeGreaterThan(3090);
    expect(totalFluidCost).toBeLessThan(3092);
  });

  it("позиция GM1 после ребаланса = $5 908.92 (последовательная WAC, не gross×frac $6 075.55)", () => {
    const result = runUcbPipelineForWallet({
      walletId: WALLET,
      ops: rebalanceOps(),
      annotationsByKey: new Map(),
      walletNameById: new Map([[WALLET, "Artur Test"]]),
    });

    const gm1 = result
      .positionTracker!.all()
      .filter(
        (p) =>
          p.walletId === WALLET &&
          p.protocolId === "arb_gmx2" &&
          p.marketKey.toLowerCase().includes(GM1.slice(2, 10)),
      );
    expect(gm1.length).toBeGreaterThan(0);
    const basis = gm1.reduce((s, p) => s + p.currentCostBasisUsd, 0);
    // 9 000 − 5 399.12 + 2 308.04 = 5 908.92 (сохранение денег)
    expect(basis).toBeGreaterThan(5907);
    expect(basis).toBeLessThan(5911);
  });

  it("второй GM-рынок (GM2) не затронут чужим выводом — базы не смешиваются", () => {
    const result = runUcbPipelineForWallet({
      walletId: WALLET,
      ops: rebalanceOps(),
      annotationsByKey: new Map(),
      walletNameById: new Map([[WALLET, "Artur Test"]]),
    });

    const gm2 = result
      .positionTracker!.all()
      .filter(
        (p) =>
          p.walletId === WALLET &&
          p.protocolId === "arb_gmx2" &&
          p.marketKey.toLowerCase().includes(GM2.slice(2, 10)),
      );
    expect(gm2.length).toBeGreaterThan(0);
    const basis = gm2.reduce((s, p) => s + p.currentCostBasisUsd, 0);
    expect(basis).toBeGreaterThan(4999);
    expect(basis).toBeLessThan(5001);
  });
});
