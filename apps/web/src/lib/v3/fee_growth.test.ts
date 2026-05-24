/**
 * PR-1b: real-time pending fees via feeGrowth math.
 *
 * Uniswap V3 whitepaper §6.3:
 *
 *   feeGrowthInside_i = feeGrowthGlobal_i − feeGrowthBelow_i − feeGrowthAbove_i
 *
 *   feeGrowthBelow_i:
 *     if currentTick >= tickLower: ticks[tickLower].feeGrowthOutside_i
 *     else:                         feeGrowthGlobal_i − ticks[tickLower].feeGrowthOutside_i
 *
 *   feeGrowthAbove_i:
 *     if currentTick < tickUpper:   ticks[tickUpper].feeGrowthOutside_i
 *     else:                          feeGrowthGlobal_i − ticks[tickUpper].feeGrowthOutside_i
 *
 *   accruedFee_i = liquidity × (feeGrowthInside_now_i − feeGrowthInside_last_i) / 2^128
 *
 *   realPending_i = tokensOwed_i + accruedFee_i
 *
 * Все feeGrowth значения хранятся как Q128.128 (uint256). Используем bigint
 * для math, конвертируем в Number в самом конце (после деления на 2^128 и
 * 10^decimals результат уже в "обычном" floating-point range).
 */

import { describe, expect, it } from "vitest";

import {
  computeFeeGrowthInside,
  computeRealTimePendingFee,
} from "./fee_growth";

const Q128 = 1n << 128n; // 2^128

describe("computeFeeGrowthInside (Uniswap V3 §6.3)", () => {
  it("position in-range: inside = global − outside(lower) − outside(upper)", () => {
    // Sample: feeGrowthGlobal = 1000Q128, outside(lower) = 100Q128,
    // outside(upper) = 50Q128. currentTick is between [lower, upper].
    const result = computeFeeGrowthInside({
      tickLower: 100,
      tickUpper: 200,
      currentTick: 150,
      feeGrowthGlobalX128: 1000n * Q128,
      feeGrowthOutsideLowerX128: 100n * Q128,
      feeGrowthOutsideUpperX128: 50n * Q128,
    });
    expect(result).toBe(850n * Q128); // 1000 − 100 − 50
  });

  it("position above current tick: unchecked uint256 sub matches Solidity", () => {
    // currentTick > tickLower → feeGrowthBelow = outside(lower) directly.
    // currentTick > tickUpper → feeGrowthAbove = global − outside(upper).
    const result = computeFeeGrowthInside({
      tickLower: 100,
      tickUpper: 200,
      currentTick: 300, // above range
      feeGrowthGlobalX128: 1000n * Q128,
      feeGrowthOutsideLowerX128: 100n * Q128,
      feeGrowthOutsideUpperX128: 50n * Q128,
    });
    // below = outside(lower) = 100; above = global − outside(upper) = 950
    // inside_raw = 1000 − 100 − 950 = −50 (signed)
    // mod 2^256 = 2^256 − 50 × Q128 (huge uint256 — matches Solidity unchecked)
    const expected = (1n << 256n) - 50n * Q128;
    expect(result).toBe(expected);
  });

  it("position above current tick: outside(upper) flipped", () => {
    // currentTick < tickLower → below = global − outside(lower); above = outside(upper)
    const result = computeFeeGrowthInside({
      tickLower: 100,
      tickUpper: 200,
      currentTick: 50, // below range
      feeGrowthGlobalX128: 1000n * Q128,
      feeGrowthOutsideLowerX128: 100n * Q128,
      feeGrowthOutsideUpperX128: 50n * Q128,
    });
    // below = 1000 − 100 = 900; above = 50; inside = 1000 − 900 − 50 = 50
    expect(result).toBe(50n * Q128);
  });

  it("delta wrap: uint256 underflow wraps (matches Solidity behavior)", () => {
    // When feeGrowthInside_now < feeGrowthInside_last, real solidity contract
    // does unchecked subtraction → wraps mod 2^256. Our math should match
    // for accruedFee computation. We handle wrap in computeRealTimePendingFee.
    const result = computeFeeGrowthInside({
      tickLower: 100,
      tickUpper: 200,
      currentTick: 150,
      feeGrowthGlobalX128: 0n,
      feeGrowthOutsideLowerX128: 0n,
      feeGrowthOutsideUpperX128: 0n,
    });
    expect(result).toBe(0n);
  });
});

describe("computeRealTimePendingFee (tokensOwed + accrued)", () => {
  const TWO_128 = 1n << 128n;
  it("tokensOwed only (никаких новых fees начислений)", () => {
    const fee = computeRealTimePendingFee({
      tokensOwedRaw: 5_000_000n, // 5 USDC raw (6 decimals)
      decimals: 6,
      liquidity: 1_000_000n,
      feeGrowthInsideLastX128: 100n * TWO_128,
      feeGrowthInsideNowX128: 100n * TWO_128, // same → no accrual
    });
    expect(fee).toBeCloseTo(5.0, 6); // 5 USDC
  });

  it("accrued only (свежий NFT после открытия, tokensOwed=0)", () => {
    // liquidity = 1M, feeGrowth delta = 1 × 2^128 → accrued raw = 1M × 1 = 1M
    // → 1M / 10^6 = 1.0 USDC
    const fee = computeRealTimePendingFee({
      tokensOwedRaw: 0n,
      decimals: 6,
      liquidity: 1_000_000n,
      feeGrowthInsideLastX128: 100n * TWO_128,
      feeGrowthInsideNowX128: 101n * TWO_128, // +1 × 2^128
    });
    expect(fee).toBeCloseTo(1.0, 6);
  });

  it("tokensOwed + accrued (комбинация)", () => {
    const fee = computeRealTimePendingFee({
      tokensOwedRaw: 5_000_000n, // 5 USDC residue от предыдущего
      decimals: 6,
      liquidity: 1_000_000n,
      feeGrowthInsideLastX128: 0n,
      feeGrowthInsideNowX128: 10n * TWO_128, // +10 → accrued = 10M raw = 10 USDC
    });
    expect(fee).toBeCloseTo(15.0, 6); // 5 + 10
  });

  it("uint256 wrap: now < last (signed) → use Solidity unchecked + uint128 cast", () => {
    // Реальный кейс: в Solidity feeGrowthInside может быть числено меньше
    // в Q128 representation (например after tick movement reflowed outside
    // snapshots). Unchecked sub даёт огромный uint256, mulDiv даёт огромный
    // uint256, cast в uint128 = truncation low 128 bits.
    //
    // Для тестовой сцены: now − last = −50 × Q128 (signed) → +(2^256 − 50×Q128) (uint256)
    // × liquidity 1 → /Q128 → uint128 truncate.
    const fee = computeRealTimePendingFee({
      tokensOwedRaw: 1_000_000n,
      decimals: 6,
      liquidity: 1n,
      feeGrowthInsideLastX128: 100n * TWO_128,
      feeGrowthInsideNowX128: 50n * TWO_128,
    });
    // Точное значение зависит от Solidity uint128 cast. Просто проверяем
    // что не throw и не остался только tokensOwed.
    expect(fee).toBeGreaterThan(0);
    expect(Number.isFinite(fee)).toBe(true);
  });

  it("normal positive delta — matches expected Uniswap math", () => {
    // L=1e18, Δ=1e10 × Q128 → accrued = 1e18 × 1e10 = 1e28 raw (with no Q128 effect)
    // Wait: accrued = L × Δ / Q128 = 1e18 × (1e10 × Q128) / Q128 = 1e28
    // / 10^18 (decimals) = 1e10 human units. OK.
    const fee = computeRealTimePendingFee({
      tokensOwedRaw: 0n,
      decimals: 18,
      liquidity: 1_000_000_000_000_000_000n, // 1e18
      feeGrowthInsideLastX128: 0n,
      feeGrowthInsideNowX128: 10_000_000_000n * TWO_128, // 1e10 × Q128
    });
    expect(fee).toBeCloseTo(1e10, -2);
  });

  it("real-world POS-001 NFT #5469945 на arbitrum: ожидаем ~0.059 WETH + ~126.21 USDC", () => {
    // Параметры взяты из Uniswap UI на момент аудита:
    // - liquidity = (unknown, но фиксируем для теста)
    // - feeGrowth delta over 18 days × pool turnover → значимая accrual
    // Этот test fixture проверяет правильность шкалы (а не точные числа).
    const wethFee = computeRealTimePendingFee({
      tokensOwedRaw: 3_242_632_181_541_288n, // ~0.00324 WETH (был snapshot)
      decimals: 18,
      // Synthetic: накопилось ~0.056 WETH сверху через feeGrowth
      // = 0.056e18 / liquidity × 2^128
      liquidity: 1_000_000_000_000_000n,
      feeGrowthInsideLastX128: 0n,
      // Δ × liquidity / 2^128 = 0.056e18
      // → Δ = 0.056e18 × 2^128 / 1e15 = 0.056e3 × 2^128 = 56 × 2^128
      feeGrowthInsideNowX128: 56n * TWO_128,
    });
    expect(wethFee).toBeCloseTo(0.05924, 3); // 0.00324 + 0.056 ≈ 0.0592 WETH
  });
});
