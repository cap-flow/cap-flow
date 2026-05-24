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
const U128_MASK = (1n << 128n) - 1n;
const U256 = 1n << 256n;
const U256_MASK = U256 - 1n;

/**
 * Unchecked uint256 modular arithmetic — повторяет поведение Solidity 0.8+
 * `unchecked { ... }` блоков. Все вычитания / сложения с feeGrowth значениями
 * должны идти через эту функцию, иначе JS signed bigint даёт неверный результат
 * (Solidity wraps mod 2^256; mы должны делать то же).
 */
function modU256(x: bigint): bigint {
  return ((x % U256) + U256) % U256;
}

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

  // All subtractions — unchecked uint256 (Solidity semantics). JS signed
  // bigint sub gives wrong result when terms wrap.
  const feeGrowthBelow =
    currentTick >= tickLower ? outsideLower : modU256(global - outsideLower);
  const feeGrowthAbove =
    currentTick < tickUpper ? outsideUpper : modU256(global - outsideUpper);

  return modU256(global - feeGrowthBelow - feeGrowthAbove);
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
 * **КРИТИЧНО — repeat Solidity unchecked uint256 math**:
 *
 *   delta_uint256 = (now − last) mod 2^256
 *   accrued_uint256 = (liquidity × delta) / 2^128
 *   accrued_uint128 = accrued_uint256 mod 2^128   (Solidity uint128 cast = truncate low 128 bits)
 *
 * Это идентично NPM contract:
 * ```solidity
 * position.tokensOwed0 += uint128(
 *   FullMath.mulDiv(
 *     feeGrowthInside0X128 - position.feeGrowthInside0LastX128,  // unchecked uint256
 *     position.liquidity,
 *     FixedPoint128.Q128
 *   )
 * );
 * ```
 *
 * Pre-fix bug (PR-1b first iteration, 2026-05-24): JS signed bigint sub
 * давал `delta < 0` для in-range NFT'ов с ненулевыми feeGrowth (когда
 * computed inside в signed math wraps), мы клампили в 0 → POS-001 lex@
 * показывал $0 pending вместо $250. Fix: ALWAYS use `modU256`.
 */
export function computeRealTimePendingFee(input: RealTimePendingFeeInput): number {
  const delta = modU256(input.feeGrowthInsideNowX128 - input.feeGrowthInsideLastX128);
  // Solidity: uint128(FullMath.mulDiv(delta_uint256, liquidity, Q128))
  // mulDiv = floor(a × b / c) within uint256, затем cast в uint128 = truncate.
  const accruedRaw = ((input.liquidity * delta) / Q128) & U128_MASK;
  const totalRaw = input.tokensOwedRaw + accruedRaw;
  return Number(totalRaw) / 10 ** input.decimals;
}
