/**
 * V3 tick ↔ price математика.
 *
 * tick → price token1/token0 (raw, без учёта decimals):
 *   price_raw = 1.0001^tick
 *
 * Чтобы получить human price (token1 за token0 в нормальных единицах):
 *   price_human = 1.0001^tick × 10^(decimals0 − decimals1)
 *
 * Для отображения «USDC за ETH» (когда token0=WETH, token1=USDC):
 *   price = 1.0001^tick × 10^(18 − 6) = ETH_price_in_USDC ✓
 */

/** tick → human price token1/token0. */
export function tickToPrice(
  tick: number,
  decimals0: number,
  decimals1: number,
): number {
  return Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1);
}

/** Текущая цена пула из sqrtPriceX96 (точнее чем через tick). */
export function sqrtPriceX96ToPrice(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
): number {
  const Q96 = 2 ** 96;
  const sqrt = Number(sqrtPriceX96) / Q96;
  return sqrt * sqrt * Math.pow(10, decimals0 - decimals1);
}

/** В диапазоне ли тек. tick относительно [tickLower, tickUpper]. */
export function isInRange(
  currentTick: number,
  tickLower: number,
  tickUpper: number,
): boolean {
  return currentTick >= tickLower && currentTick < tickUpper;
}

/** sqrt(P_raw) от tick. P_raw — token1/token0 в raw-единицах. */
export function tickToSqrtPriceRaw(tick: number): number {
  return Math.pow(1.0001, tick / 2);
}

/**
 * Раскладка V3 ликвидности на amount0/amount1 в raw-единицах при заданной
 * sqrtP. Формулы: см. Uniswap V3 whitepaper §6.2.9.
 *
 *   - sqrtP <= sqrtPa  ⇒ всё в token0 (amount1 = 0)
 *   - sqrtP >= sqrtPb  ⇒ всё в token1 (amount0 = 0)
 *   - иначе:           ⇒ смесь
 */
export function v3RawAmountsAt(args: {
  liquidityRaw: number;
  sqrtPa: number;
  sqrtPb: number;
  sqrtP: number;
}): { amount0: number; amount1: number } {
  const { liquidityRaw: L, sqrtPa, sqrtPb } = args;
  const sqrtP = clamp(args.sqrtP, sqrtPa, sqrtPb);
  const amount0 = (L * (sqrtPb - sqrtP)) / (sqrtP * sqrtPb);
  const amount1 = L * (sqrtP - sqrtPa);
  return { amount0, amount1 };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** raw → human (делим на 10^decimals). */
export function rawToHuman(raw: number, decimals: number): number {
  return raw / Math.pow(10, decimals);
}
