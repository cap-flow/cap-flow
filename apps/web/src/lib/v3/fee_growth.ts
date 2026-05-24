/**
 * Uniswap V3 real-time fee accrual math.
 *
 * Reference: Uniswap V3 whitepaper §6.3 «Fees». Reproduces то что
 * Uniswap UI и Revert Finance показывают как «Earned fees / Uncollected».
 *
 * NPM contract field `tokensOwed0/1` — snapshot после последнего `collect()`
 * или `decreaseLiquidity()`. Между этими вызовами фактические fees
 * накапливаются через `feeGrowthInside` дельту, но `tokensOwed` не растёт.
 *
 * Для real-time нужно:
 *   1. Прочитать `pool.feeGrowthGlobal0X128/1X128` (текущий global рост)
 *   2. Прочитать `pool.ticks(tickLower).feeGrowthOutside0/1X128`
 *   3. Прочитать `pool.ticks(tickUpper).feeGrowthOutside0/1X128`
 *   4. Вычислить `feeGrowthInside_now_i` по §6.3 формуле (см. ниже)
 *   5. Δ = (feeGrowthInside_now − feeGrowthInside_last) per side
 *   6. accruedRaw = liquidity × Δ / 2^128
 *   7. real = (tokensOwed + accruedRaw) / 10^decimals
 *
 * Все feeGrowth-значения — Q128.128 fixed-point (uint256 → bigint в JS).
 */

const Q128 = 1n << 128n;
const U256_MASK = (1n << 256n) - 1n;

export interface FeeGrowthInsideInput {
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  feeGrowthGlobalX128: bigint;
  feeGrowthOutsideLowerX128: bigint;
  feeGrowthOutsideUpperX128: bigint;
}

/**
 * Compute `feeGrowthInside_i` (Q128.128) для одной стороны pool'а (token0 или token1).
 *
 * Uniswap V3 §6.3:
 * ```
 * feeGrowthBelow = currentTick >= tickLower
 *     ? outsideLower
 *     : feeGrowthGlobal - outsideLower
 *
 * feeGrowthAbove = currentTick < tickUpper
 *     ? outsideUpper
 *     : feeGrowthGlobal - outsideUpper
 *
 * feeGrowthInside = feeGrowthGlobal - feeGrowthBelow - feeGrowthAbove
 * ```
 *
 * Solidity делает unchecked uint256 arithmetic (мы используем bigint без mask,
 * что даёт точные signed результаты — для дельты `now − last` это нормально:
 * мы используем delta, обернутую в caller через mask, для корректного
 * accrual когда `now < last` теоретически).
 */
export function computeFeeGrowthInside(input: FeeGrowthInsideInput): bigint {
  const { tickLower, tickUpper, currentTick } = input;
  const global = input.feeGrowthGlobalX128;
  const outsideLower = input.feeGrowthOutsideLowerX128;
  const outsideUpper = input.feeGrowthOutsideUpperX128;

  const feeGrowthBelow =
    currentTick >= tickLower ? outsideLower : global - outsideLower;
  const feeGrowthAbove =
    currentTick < tickUpper ? outsideUpper : global - outsideUpper;

  return global - feeGrowthBelow - feeGrowthAbove;
}

export interface RealTimePendingFeeInput {
  /** `positions().tokensOwed0` или `tokensOwed1` (raw uint128). */
  tokensOwedRaw: bigint;
  /** Decimals целевого токена (token0 или token1). */
  decimals: number;
  /** `positions().liquidity` (uint128). */
  liquidity: bigint;
  /** `positions().feeGrowthInside0LastX128` или 1Last — Q128.128. */
  feeGrowthInsideLastX128: bigint;
  /** Текущий `feeGrowthInside` — выход `computeFeeGrowthInside`. */
  feeGrowthInsideNowX128: bigint;
}

/**
 * Real-time pending fee в human-units = `(tokensOwed + accruedRaw) / 10^decimals`.
 *
 * `accruedRaw = liquidity × (now − last) / 2^128`.
 *
 * Solidity делает unchecked sub: если `now < last` (теоретически, после
 * reset'а), wraps mod 2^256. В JS bigint signed → если результат
 * negative, считаем 0 (defensive — не показываем negative pending).
 */
export function computeRealTimePendingFee(input: RealTimePendingFeeInput): number {
  let delta = input.feeGrowthInsideNowX128 - input.feeGrowthInsideLastX128;
  // Defensive: если delta negative (теоретический wrap или reset), используем
  // 2-complement wrap mod 2^256 (как Solidity). Если после wrap всё ещё
  // выглядит как «огромный positive», clamp на 0.
  if (delta < 0n) {
    const wrapped = (delta + (1n << 256n)) & U256_MASK;
    // 50% порог: если wrapped > 2^255, это был "real negative" → 0
    delta = wrapped > 1n << 255n ? 0n : wrapped;
  }
  const accruedRaw = (input.liquidity * delta) / Q128;
  const totalRaw = input.tokensOwedRaw + accruedRaw;
  // Convert to human units (Number). For typical V3 fees this stays well
  // within Number precision (max ~1e18 / 1e6 = 1e12, far from 2^53).
  return Number(totalRaw) / 10 ** input.decimals;
}
