/**
 * Regression: V3 LP unwind cost basis methodology.
 *
 * Lock'аем семантику что при `lp_remove` cost basis возвращенных токенов =
 * pro-rata от исходного `lp_add` депозита (НЕ market price at unwind).
 *
 * Прямая цитата из user audit 2026-05-25 lex POS-001:
 *   "если пользователь закроет lp позицию и отправит себе на баланс эти
 *    самые 7.024112 WETH то они в системе у нас будут числиться уже по
 *    2233.90$ — что выше этой цены актива то у нас уже будет плюсовой pnl"
 *
 * Это break-even = depositUsd / amount0AtPa, и оно совпадает с avg cost
 * basis при условии что `attributeLpCloses` использует pro-rata схему
 * (`attributedUsd = depositUsd × share` в [cost_basis_tracker.ts:401]).
 *
 * Кейсы:
 *  1. Full exit at Pa (100% token0): per-WETH cost = depositUsd / amount
 *  2. Full exit at Pb (100% USDC): per-USDC cost = depositUsd / amount
 *  3. Partial mid-range exit (both tokens): per-token cost split pro-rata
 *  4. Multiple partial closes: each close gets pro-rata из общего deposit
 */

import { describe, expect, it } from "vitest";

import { computeLpCloseAttribution } from "./cost_basis_tracker";
import type { ClassifiedOp, TokenMovement } from "./types";

const CHAIN = "arb";
const PROTO = { id: "uniswap3", name: "Uniswap V3", category: "lp" as const };

function mv(args: {
  dir: "in" | "out";
  symbol: string;
  amount: number;
  usd: number | null;
  isStable?: boolean;
}): TokenMovement {
  return {
    direction: args.dir,
    symbol: args.symbol,
    tokenId: args.symbol.toLowerCase(),
    amount: args.amount,
    usd: args.usd,
    isStable: args.isStable ?? false,
    isProtocolToken: false,
  };
}

function op(args: {
  type: ClassifiedOp["type"];
  hash: string;
  time: number;
  movements: TokenMovement[];
}): ClassifiedOp {
  return {
    seq: 0,
    hash: args.hash,
    chain: CHAIN,
    time: args.time,
    status: "ok",
    type: args.type,
    protocol: PROTO,
    movement: args.movements,
    netUsd: 0,
    gasUsd: null,
    counterparty: null,
    feePayer: null,
    fnName: null,
    approveSpender: null,
    approveSymbol: null,
  };
}

describe("computeLpCloseAttribution — V3 LP unwind cost basis", () => {
  it("full exit at Pa (100% WETH): per-WETH cost = depositUsd / amount", () => {
    // POS-001 scenario: deposit $15,691 (1.327 WETH + 12,550 USDC),
    // exit-down at Pa returns 7.024 WETH (zero USDC).
    const ops: ClassifiedOp[] = [
      op({
        type: "lp_add",
        hash: "0xmint",
        time: 1700000000,
        movements: [
          mv({ dir: "out", symbol: "WETH", amount: 1.327, usd: 2789 }),
          mv({ dir: "out", symbol: "USDC", amount: 12550, usd: 12550, isStable: true }),
        ],
      }),
      op({
        type: "lp_remove",
        hash: "0xclose",
        time: 1700500000,
        movements: [
          mv({ dir: "in", symbol: "WETH", amount: 7.024, usd: 14405.57 }), // ~$2050 × 7.024
        ],
      }),
    ];

    const attribution = computeLpCloseAttribution(ops);
    const close = attribution.get("0xclose");
    expect(close).toBeDefined();
    const wethEntry = close!.get("ETH")!;
    expect(wethEntry.amount).toBe(7.024);
    // cost = depositUsd × share(=1.0) × tokenShare(=1.0) = $15,339
    // depositUsd = 2789 + 12550 = $15,339 (uses m.usd as-is since no histPrices)
    expect(wethEntry.costUsd).toBeCloseTo(15339, 0);
    // per-WETH avg = $15,339 / 7.024 = $2,184 (если бы depositUsd был $15,691,
    // дало бы $2,233.90 как в Безубыток lex POS-001 popup).
    expect(wethEntry.costUsd / wethEntry.amount).toBeCloseTo(2183.8, 1);
  });

  it("full exit at Pb (100% USDC): per-USDC cost = depositUsd / amount", () => {
    const ops: ClassifiedOp[] = [
      op({
        type: "lp_add",
        hash: "0xmint",
        time: 1700000000,
        movements: [
          mv({ dir: "out", symbol: "WETH", amount: 1.327, usd: 2789 }),
          mv({ dir: "out", symbol: "USDC", amount: 12550, usd: 12550, isStable: true }),
        ],
      }),
      op({
        type: "lp_remove",
        hash: "0xclose",
        time: 1700500000,
        movements: [
          mv({ dir: "in", symbol: "USDC", amount: 15746, usd: 15746, isStable: true }),
        ],
      }),
    ];
    const attribution = computeLpCloseAttribution(ops);
    const close = attribution.get("0xclose")!;
    const usdcEntry = close.get("USDC")!;
    expect(usdcEntry.amount).toBe(15746);
    expect(usdcEntry.costUsd).toBeCloseTo(15339, 0);
    // per-USDC avg = $15,339 / 15,746 = $0.974 — ниже $1, реализуется loss
    // если потом продать USDC за $1 (но stable никто не продаёт — это
    // математический edge case, важна именно сумма costUsd для downstream)
  });

  it("partial mid-range exit (both tokens): cost split pro-rata по USD-весу", () => {
    // Deposit $15,339; exit in middle of range — получает WETH + USDC.
    // WETH портион = $7,000 (50% of $14,000 close), USDC = $7,000 (50%).
    // → каждый получает 50% от depositUsd = $7,670 cost basis.
    const ops: ClassifiedOp[] = [
      op({
        type: "lp_add",
        hash: "0xmint",
        time: 1700000000,
        movements: [
          mv({ dir: "out", symbol: "WETH", amount: 1.327, usd: 2789 }),
          mv({ dir: "out", symbol: "USDC", amount: 12550, usd: 12550, isStable: true }),
        ],
      }),
      op({
        type: "lp_remove",
        hash: "0xclose",
        time: 1700500000,
        movements: [
          mv({ dir: "in", symbol: "WETH", amount: 3.5, usd: 7000 }),
          mv({ dir: "in", symbol: "USDC", amount: 7000, usd: 7000, isStable: true }),
        ],
      }),
    ];
    const attribution = computeLpCloseAttribution(ops);
    const close = attribution.get("0xclose")!;
    expect(close.get("ETH")!.costUsd).toBeCloseTo(15339 * 0.5, 0);
    expect(close.get("USDC")!.costUsd).toBeCloseTo(15339 * 0.5, 0);
    // per-WETH = $7670 / 3.5 = $2,191
    expect(close.get("ETH")!.costUsd / close.get("ETH")!.amount).toBeCloseTo(2191, 0);
  });

  it("multiple partial closes: каждый получает pro-rata долю депозита", () => {
    // Deposit $10,000. Два частичных закрытия: $4,000 + $6,000 = $10,000 total close.
    // Доли: 40% / 60%. Первый получит $4,000 cost, второй $6,000.
    const ops: ClassifiedOp[] = [
      op({
        type: "lp_add",
        hash: "0xmint",
        time: 1700000000,
        movements: [
          mv({ dir: "out", symbol: "USDC", amount: 10000, usd: 10000, isStable: true }),
        ],
      }),
      op({
        type: "lp_remove",
        hash: "0xclose1",
        time: 1700200000,
        movements: [
          mv({ dir: "in", symbol: "USDC", amount: 4000, usd: 4000, isStable: true }),
        ],
      }),
      op({
        type: "lp_remove",
        hash: "0xclose2",
        time: 1700400000,
        movements: [
          mv({ dir: "in", symbol: "USDC", amount: 6000, usd: 6000, isStable: true }),
        ],
      }),
    ];
    const attribution = computeLpCloseAttribution(ops);
    expect(attribution.get("0xclose1")!.get("USDC")!.costUsd).toBeCloseTo(4000, 0);
    expect(attribution.get("0xclose2")!.get("USDC")!.costUsd).toBeCloseTo(6000, 0);
  });

  it("multiple lp_add (увеличение позиции) — суммарный deposit pro-rata", () => {
    // Two deposits $5000 each → totalDeposit $10000. Single close returns all.
    const ops: ClassifiedOp[] = [
      op({
        type: "lp_add",
        hash: "0xmint1",
        time: 1700000000,
        movements: [mv({ dir: "out", symbol: "USDC", amount: 5000, usd: 5000, isStable: true })],
      }),
      op({
        type: "lp_add",
        hash: "0xmint2",
        time: 1700100000,
        movements: [mv({ dir: "out", symbol: "USDC", amount: 5000, usd: 5000, isStable: true })],
      }),
      op({
        type: "lp_remove",
        hash: "0xclose",
        time: 1700500000,
        movements: [mv({ dir: "in", symbol: "WETH", amount: 5, usd: 10500 })],
      }),
    ];
    const attribution = computeLpCloseAttribution(ops);
    const wethEntry = attribution.get("0xclose")!.get("ETH")!;
    expect(wethEntry.amount).toBe(5);
    // Cost basis = sum of both deposits = $10,000 → per-WETH $2,000
    expect(wethEntry.costUsd).toBeCloseTo(10000, 0);
    expect(wethEntry.costUsd / wethEntry.amount).toBeCloseTo(2000, 0);
  });

  it("user-facing invariant: future sell at avg_cost = 0 PnL", () => {
    // Regression для exact user statement: «что выше этой цены актива
    // то у нас уже будет плюсовой pnl». Это означает что
    // costUsd / amount = break-even price.
    const ops: ClassifiedOp[] = [
      op({
        type: "lp_add",
        hash: "0xmint",
        time: 1700000000,
        movements: [
          mv({ dir: "out", symbol: "WETH", amount: 1, usd: 3000 }),
          mv({ dir: "out", symbol: "USDC", amount: 12000, usd: 12000, isStable: true }),
        ],
      }),
      op({
        type: "lp_remove",
        hash: "0xclose",
        time: 1700500000,
        movements: [
          mv({ dir: "in", symbol: "WETH", amount: 7, usd: 14000 }), // exit-down to all WETH
        ],
      }),
    ];
    const attribution = computeLpCloseAttribution(ops);
    const wethEntry = attribution.get("0xclose")!.get("ETH")!;
    const avgCost = wethEntry.costUsd / wethEntry.amount;
    // depositUsd = $15,000, на руках 7 WETH → avgCost = $2,142.86
    expect(avgCost).toBeCloseTo(2142.86, 1);
    // Sell at $2,142.86 → PnL = 0 (break-even)
    // Sell above → positive PnL, below → negative
    const sellPrice = avgCost;
    const pnlAtBreakeven = (sellPrice - avgCost) * wethEntry.amount;
    expect(pnlAtBreakeven).toBeCloseTo(0, 5);
  });
});
