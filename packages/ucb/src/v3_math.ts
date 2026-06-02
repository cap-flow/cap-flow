/**
 * V3 tick ↔ price math (UCB engine — B3-full layer 2a). Moved verbatim from web
 * `lib/v3/math.ts` so the client + the server compute V3 amounts/prices identically.
 *
 *   tick → price token1/token0 (raw): price_raw = 1.0001^tick
 *   human price: price_raw × 10^(decimals0 − decimals1)
 */

/** tick → human price token1/token0. */
export function tickToPrice(
  tick: number,
  decimals0: number,
  decimals1: number,
): number {
  return Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1);
}

/** Current pool price from sqrtPriceX96 (more precise than via tick). */
export function sqrtPriceX96ToPrice(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
): number {
  const Q96 = 2 ** 96;
  const sqrt = Number(sqrtPriceX96) / Q96;
  return sqrt * sqrt * Math.pow(10, decimals0 - decimals1);
}

/** Whether currentTick is in [tickLower, tickUpper). */
export function isInRange(
  currentTick: number,
  tickLower: number,
  tickUpper: number,
): boolean {
  return currentTick >= tickLower && currentTick < tickUpper;
}

/** sqrt(P_raw) from tick. P_raw = token1/token0 in raw units. */
export function tickToSqrtPriceRaw(tick: number): number {
  return Math.pow(1.0001, tick / 2);
}

/**
 * Split V3 liquidity into raw amount0/amount1 at a given sqrtP (Uniswap V3
 * whitepaper §6.2.9):
 *   sqrtP <= sqrtPa ⇒ all token0 (amount1 = 0)
 *   sqrtP >= sqrtPb ⇒ all token1 (amount0 = 0)
 *   else            ⇒ mix
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

/** raw → human (divide by 10^decimals). */
export function rawToHuman(raw: number, decimals: number): number {
  return raw / Math.pow(10, decimals);
}
