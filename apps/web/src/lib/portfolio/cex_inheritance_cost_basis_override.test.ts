/**
 * Tests for applyCexInheritanceCostBasisOverride.
 *
 * Задача: позиции, у которых underlying tokens пришли НЕ через on-chain
 * покупку (а через withdrawal с CEX по матчевому tx-hash или через
 * lp_unwind), сейчас отображаются с приближённым `startUsd` через
 * extrapolation cost_basis_tracker.avg × amount. Это даёт сильно
 * искажённое значение, если direct-buy покрытие низкое (<5%).
 *
 * Override берёт `cexCostBasisByHash` (вытащен на сервере через WAC-пул
 * P2P → trades → withdrawals на бирже) и `lp_close_attribution` events,
 * и подменяет startUsd на **blended WAC × amount** — взвешенная средняя
 * по ВСЕМ известным источникам.
 *
 * Применяется ПОСЛЕ `applyLendingCostBasisOverride` — для позиций где
 * direct-buy покрытие достаточно (≥95%), lending FIFO уже дал хороший
 * startUsd, и мы НЕ перетираем.
 */
import { describe, expect, it } from "vitest";

import type { OpenPosition, OpenPositionToken } from "./open_positions";
import type { ClassifiedOp, TokenMovement } from "./types";
import type { CexCostBasisMatch } from "./position_coverage";
import { applyCexInheritanceCostBasisOverride } from "./cex_inheritance_cost_basis_override";

/* ─── fixtures ─── */

function tok(p: Partial<OpenPositionToken> & Pick<OpenPositionToken, "symbol" | "amount">): OpenPositionToken {
  return {
    currentUsd: p.amount * 60000, // default = WBTC-ish current price
    avgBuyPrice: null,
    startUsd: p.amount * 60000,
    priceSource: "fallback",
    ...p,
  };
}

function pos(p: Partial<OpenPosition> & Pick<OpenPosition, "id" | "supplyTokens">): OpenPosition {
  const startUsd =
    p.startUsd ?? p.supplyTokens.reduce((s, t) => s + t.startUsd, 0);
  const currentUsd =
    p.currentUsd ?? p.supplyTokens.reduce((s, t) => s + t.currentUsd, 0);
  return {
    walletId: "W1",
    walletName: "Wallet 1",
    walletChain: "eth",
    chain: "eth",
    protocol: { id: "aave_v3", name: "Aave V3" } as OpenPosition["protocol"],
    kind: "lending",
    itemName: "Lending",
    openedAt: 1700000000,
    openHash: null,
    ageDays: 30,
    debtTokens: [],
    currentDebtUsd: 0,
    healthRate: null,
    feesUsd: null,
    feesSource: null,
    feesClaimedUsd: 0,
    feesLifetimeUsd: 0,
    feeApr: null,
    feeAprLifetime: null,
    feesClaimedHistory: [],
    feesByToken: [],
    creditFundedUsd: 0,
    netPnlUsd: currentUsd - startUsd,
    netPnlPct: startUsd > 0 ? ((currentUsd - startUsd) / startUsd) * 100 : 0,
    ...p,
    startUsd,
    currentUsd,
  } as OpenPosition;
}

function move(p: Partial<TokenMovement> & Pick<TokenMovement, "symbol" | "amount" | "direction">): TokenMovement {
  return {
    isProtocolToken: false,
    usd: null,
    tokenId: undefined,
    ...p,
  } as TokenMovement;
}

interface OpFixture extends Omit<ClassifiedOp, "movement"> {
  movement: TokenMovement[];
}

function op(p: Partial<OpFixture> & Pick<OpFixture, "hash" | "type" | "movement">): ClassifiedOp {
  return {
    chain: "eth",
    time: 1700000000,
    status: "ok",
    feeUsd: 0,
    counterparty: null,
    ...p,
  } as ClassifiedOp;
}

/* ─── tests ─── */

describe("applyCexInheritanceCostBasisOverride — degenerate cases", () => {
  it("empty positions → empty result, no warnings", () => {
    const r = applyCexInheritanceCostBasisOverride(
      [],
      new Map(),
      new Map(),
    );
    expect(r.positions).toEqual([]);
    expect(r.overriddenCount).toBe(0);
    expect(r.warnings).toEqual([]);
  });

  it("empty cexCostBasisByHash → no-op (returns positions unchanged)", () => {
    const positions = [
      pos({ id: "POS-1", supplyTokens: [tok({ symbol: "WBTC", amount: 0.1 })] }),
    ];
    const r = applyCexInheritanceCostBasisOverride(
      positions,
      new Map([["W1", []]]),
      new Map(),
    );
    expect(r.overriddenCount).toBe(0);
    expect(r.positions[0]).toBe(positions[0]); // same reference
  });

  it("position without ops → skip", () => {
    const r = applyCexInheritanceCostBasisOverride(
      [pos({ id: "POS-1", supplyTokens: [tok({ symbol: "WBTC", amount: 0.1 })] })],
      new Map(), // no ops for wallet
      new Map([["0xa", { costBasisUsd: 6000, source: "fiat-direct", asset: "WBTC" }]]),
    );
    expect(r.overriddenCount).toBe(0);
  });

  it("position with ops, but no matching transfer_in → skip", () => {
    // Все pure transfers внутри (без CEX-следа). Coverage = unknown.
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xunmatched",
        type: "transfer",
        movement: [move({ symbol: "WBTC", amount: 0.1, direction: "in" })],
      }),
    ];
    const r = applyCexInheritanceCostBasisOverride(
      [pos({ id: "POS-1", supplyTokens: [tok({ symbol: "WBTC", amount: 0.1 })] })],
      new Map([["W1", ops]]),
      new Map([["0xother", { costBasisUsd: 6000, source: "fiat-direct", asset: "WBTC" }]]),
    );
    expect(r.overriddenCount).toBe(0);
  });
});

describe("applyCexInheritanceCostBasisOverride — pure CEX inheritance", () => {
  it("transfer_in matched к CEX withdrawal → startUsd = inherited cost", () => {
    // Сценарий: 0.1 WBTC пришло целиком с биржи по tx-hash X,
    // server-side cost basis = $6000. Direct buy = 0. Override должен
    // дать startUsd = $6000 (vs прежний $60000-ish extrapolation).
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xbingx",
        type: "transfer",
        movement: [move({ symbol: "WBTC", amount: 0.1, direction: "in" })],
      }),
    ];
    const positions = [
      pos({
        id: "POS-1",
        supplyTokens: [
          tok({ symbol: "WBTC", amount: 0.1, startUsd: 9000 /* bad extrapolation */ }),
        ],
        startUsd: 9000,
      }),
    ];
    const r = applyCexInheritanceCostBasisOverride(
      positions,
      new Map([["W1", ops]]),
      new Map([["0xbingx", { costBasisUsd: 6000, source: "fiat-direct", asset: "WBTC" }]]),
    );
    expect(r.overriddenCount).toBe(1);
    expect(r.positions[0]!.startUsd).toBe(6000);
    expect(r.positions[0]!.supplyTokens[0]!.startUsd).toBe(6000);
    // PnL recomputed
    const cur = r.positions[0]!.currentUsd;
    expect(r.positions[0]!.netPnlUsd).toBeCloseTo(cur - 6000, 6);
  });

  it("hash match case-insensitive", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xMixedCase",
        type: "transfer",
        movement: [move({ symbol: "WBTC", amount: 0.1, direction: "in" })],
      }),
    ];
    const positions = [
      pos({
        id: "POS-1",
        supplyTokens: [tok({ symbol: "WBTC", amount: 0.1, startUsd: 9000 })],
      }),
    ];
    const r = applyCexInheritanceCostBasisOverride(
      positions,
      new Map([["W1", ops]]),
      new Map([
        ["0xmixedcase", { costBasisUsd: 6000, source: "fiat-direct", asset: "WBTC" }],
      ]),
    );
    expect(r.overriddenCount).toBe(1);
    expect(r.positions[0]!.startUsd).toBe(6000);
  });
});

describe("applyCexInheritanceCostBasisOverride — skip when direct coverage is high", () => {
  it("direct buy ≥ 95% покрытия → skip (lending FIFO уже хорош)", () => {
    // Сценарий: 0.1 WBTC, 0.098 куплено напрямую (98%), 0.002 — CEX.
    // applyLendingCostBasisOverride уже дал отличный startUsd; не
    // перетираем blended-цифрой.
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xbuy",
        type: "swap",
        movement: [
          move({ symbol: "USDT", amount: 5880, direction: "out" }),
          move({ symbol: "WBTC", amount: 0.098, direction: "in" }),
        ],
      }),
      op({
        hash: "0xbingx",
        type: "transfer",
        movement: [move({ symbol: "WBTC", amount: 0.002, direction: "in" })],
        time: 1700000100,
      }),
    ];
    const positions = [
      pos({
        id: "POS-1",
        supplyTokens: [tok({ symbol: "WBTC", amount: 0.1, startUsd: 6000 })],
        startUsd: 6000,
      }),
    ];
    const r = applyCexInheritanceCostBasisOverride(
      positions,
      new Map([["W1", ops]]),
      new Map([["0xbingx", { costBasisUsd: 120, source: "fiat-direct", asset: "WBTC" }]]),
    );
    expect(r.overriddenCount).toBe(0); // не вмешиваемся
    expect(r.positions[0]).toBe(positions[0]);
  });
});

describe("applyCexInheritanceCostBasisOverride — blended WAC (direct + CEX)", () => {
  it("3% direct + 90% CEX → blended startUsd by combined WAC", () => {
    // Сценарий POS-007:
    //   0.1 WBTC total
    //   0.003 направлено swap'ом USDT→WBTC (cost = $180)
    //   0.090 transfer_in с CEX (cost = $5400)
    //   0.007 transfer_in без CEX-следа (unknown)
    // Blended WAC = ($180 + $5400) / (0.003 + 0.090) = $5580 / 0.093 = $60_000
    // newStartUsd = 0.1 × $60_000 = $6000
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xbuy",
        type: "swap",
        movement: [
          move({ symbol: "USDT", amount: 180, direction: "out" }),
          move({ symbol: "WBTC", amount: 0.003, direction: "in" }),
        ],
        time: 1700000000,
      }),
      op({
        hash: "0xcex",
        type: "transfer",
        movement: [move({ symbol: "WBTC", amount: 0.09, direction: "in" })],
        time: 1700001000,
      }),
      op({
        hash: "0xinternal",
        type: "transfer",
        movement: [move({ symbol: "WBTC", amount: 0.007, direction: "in" })],
        time: 1700002000,
      }),
    ];
    const positions = [
      pos({
        id: "POS-1",
        supplyTokens: [
          tok({ symbol: "WBTC", amount: 0.1, startUsd: 9000, currentUsd: 7000 }),
        ],
      }),
    ];
    const r = applyCexInheritanceCostBasisOverride(
      positions,
      new Map([["W1", ops]]),
      new Map([["0xcex", { costBasisUsd: 5400, source: "fiat-direct", asset: "WBTC" }]]),
    );
    expect(r.overriddenCount).toBe(1);
    expect(r.positions[0]!.startUsd).toBeCloseTo(6000, 2);
    expect(r.positions[0]!.netPnlUsd).toBeCloseTo(7000 - 6000, 2);
  });
});

describe("applyCexInheritanceCostBasisOverride — multi-token positions", () => {
  it("ETH+USDC LP, ETH покрыт CEX, USDC оставляем как есть", () => {
    // Position с двумя supply tokens. Override применяется только к
    // тому что покрыто CEX (ETH); USDC сохраняет prior startUsd.
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xcex",
        type: "transfer",
        movement: [move({ symbol: "ETH", amount: 1, direction: "in" })],
        time: 1700000000,
      }),
    ];
    const positions = [
      pos({
        id: "POS-1",
        supplyTokens: [
          tok({ symbol: "ETH", amount: 1, startUsd: 3000, currentUsd: 3500 }),
          tok({ symbol: "USDC", amount: 5000, startUsd: 5000, currentUsd: 5000 }),
        ],
        startUsd: 8000,
        currentUsd: 8500,
      }),
    ];
    const r = applyCexInheritanceCostBasisOverride(
      positions,
      new Map([["W1", ops]]),
      new Map([["0xcex", { costBasisUsd: 2500, source: "fiat-direct", asset: "ETH" }]]),
    );
    expect(r.overriddenCount).toBe(1);
    const eth = r.positions[0]!.supplyTokens.find((t) => t.symbol === "ETH")!;
    const usdc = r.positions[0]!.supplyTokens.find((t) => t.symbol === "USDC")!;
    expect(eth.startUsd).toBeCloseTo(2500, 2);
    expect(usdc.startUsd).toBe(5000); // sticky
    expect(r.positions[0]!.startUsd).toBeCloseTo(2500 + 5000, 2);
  });
});

describe("applyCexInheritanceCostBasisOverride — original positions immutability", () => {
  it("input positions array не мутируется", () => {
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xcex",
        type: "transfer",
        movement: [move({ symbol: "WBTC", amount: 0.1, direction: "in" })],
      }),
    ];
    const orig = pos({
      id: "POS-1",
      supplyTokens: [tok({ symbol: "WBTC", amount: 0.1, startUsd: 9000 })],
    });
    const origStartUsd = orig.startUsd;
    const positions = [orig];
    applyCexInheritanceCostBasisOverride(
      positions,
      new Map([["W1", ops]]),
      new Map([["0xcex", { costBasisUsd: 6000, source: "fiat-direct", asset: "WBTC" }]]),
    );
    expect(orig.startUsd).toBe(origStartUsd);
    expect(positions[0]).toBe(orig); // input array sees no mutation
  });
});

describe("applyCexInheritanceCostBasisOverride — change-detection threshold", () => {
  it("difference < 0.5% от старого startUsd → skip (noise floor)", () => {
    // Защита от перетирания "почти-точного" startUsd на blended-цифру
    // если разница меньше 0.5%. Уменьшает шум в warnings.
    const ops: ClassifiedOp[] = [
      op({
        hash: "0xcex",
        type: "transfer",
        movement: [move({ symbol: "WBTC", amount: 0.1, direction: "in" })],
      }),
    ];
    const positions = [
      pos({
        id: "POS-1",
        supplyTokens: [tok({ symbol: "WBTC", amount: 0.1, startUsd: 6010 })],
      }),
    ];
    const r = applyCexInheritanceCostBasisOverride(
      positions,
      new Map([["W1", ops]]),
      new Map([["0xcex", { costBasisUsd: 6000, source: "fiat-direct", asset: "WBTC" }]]),
    );
    // 6010 vs 6000 = 0.17% diff < 0.5% → skip
    expect(r.overriddenCount).toBe(0);
  });
});
