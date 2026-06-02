/**
 * V3 LP shared types + key helper (UCB engine — B3-full layer 1).
 *
 * Moved verbatim from the web `lib/v3/*` so both the client (which fetches them
 * via viem/Alchemy hooks) and the server (B3-full enrichment fetch) feed the SAME
 * `applyV3CostBasisOverride`. Only the DATA SHAPES + the pure `v3PositionKey` live
 * here; the fetch that PRODUCES them stays client-side / server-side.
 *
 * viem-free: viem's `Address` is exactly `` `0x${string}` `` (a native TS template
 * literal type), so we alias it here without importing viem — keeping the package
 * dependency-light.
 */

/** EVM address — identical to viem's `Address`. */
export type HexAddress = `0x${string}`;

/**
 * One on-chain V3 NFT position (the override reads token symbols + current
 * amounts + pending fees; the rest are fetch-side fields kept for fidelity).
 */
export interface V3Position {
  /** Deployment id (uniswap-v3-arb / pancake-v3-bsc / ...). */
  deploymentId: string;
  /** Protocol label (for UI). */
  protocolLabel: string;
  /** Chain code (eth/arb/op/...). */
  chain: string;
  /** NFT tokenId. */
  tokenId: bigint;
  /** Pool address. */
  poolAddress: HexAddress;
  token0: { address: HexAddress; symbol: string; decimals: number };
  token1: { address: HexAddress; symbol: string; decimals: number };
  /** Fee tier (3000 = 0.3%). */
  feeTier: number;
  tickLower: number;
  tickUpper: number;
  /** Lower-bound price (token1 per token0). */
  priceLower: number;
  /** Upper-bound price. */
  priceUpper: number;
  /** Current pool price. */
  currentPrice: number;
  /** Current pool tick. */
  currentTick: number;
  /** NFT liquidity (raw uint128). */
  liquidity: bigint;
  /** Whether currentTick is in range. */
  inRange: boolean;
  /** Current amounts in human units (rebalanced to currentPrice). */
  amount0Current: number;
  amount1Current: number;
  /** Amounts at the lower bound (price = Pa): all token0. */
  amount0AtPa: number;
  amount1AtPa: number;
  /** Amounts at the upper bound (price = Pb): all token1. */
  amount0AtPb: number;
  amount1AtPb: number;
  /** On-chain pending fees snapshot from NPM `positions(tokenId)` tokensOwed. */
  tokensOwed0: number;
  tokensOwed1: number;
  pendingFee0: number;
  pendingFee1: number;
}

export interface V3CostBasisResult {
  /** NFT tokenId (for matching with V3Position). */
  tokenId: bigint;
  /** Σ amount0 from all IncreaseLiquidity events (human-readable). */
  totalDeposited0: number;
  /** Σ amount1. */
  totalDeposited1: number;
  /** Σ amount0 from DecreaseLiquidity (withdrawn). */
  totalWithdrawn0: number;
  totalWithdrawn1: number;
  /** Σ deposit USD at each event time (via historical prices). */
  totalDepositUsd: number;
  /** Σ withdraw USD by hist prices. */
  totalWithdrawUsd: number;
  /** Net cost basis = deposit − withdraw (WAC). */
  netCostBasisUsd: number;
  /** Event counts (debug). */
  eventCount: { increase: number; decrease: number };
  /** Whether historical prices were used (false = DeBank current spot fallback). */
  hasHistPrices: boolean;
  /** Earliest IncreaseLiquidity tx hash = mint tx (matches OpenPosition.openHash). */
  mintTxHash?: string;
  /** Earliest IncreaseLiquidity block time = mint time (orphan openedAt backfill). */
  mintBlockTime?: number;
  /** Per-tx DecreaseLiquidity amounts (principal vs collect separation). */
  withdrawalsByTxHash?: Map<string, { amount0: number; amount1: number }>;
}

/** One IncreaseLiquidity / DecreaseLiquidity event (raw amounts, decimals applied by the consumer). */
export interface V3LiquidityEvent {
  /** "increase" = mint OR additional liquidity; "decrease" = partial/full burn. */
  type: "increase" | "decrease";
  /** NFT tokenId. */
  tokenId: bigint;
  /** Block number. */
  blockNumber: bigint;
  /** Block timestamp (unix sec) — filled by a separate fetch when needed. */
  blockTime?: number;
  /** Tx hash. */
  txHash: string;
  /** Liquidity delta (raw uint128). */
  liquidity: bigint;
  /** Raw amount0 (uint256, token0 decimals). */
  amount0Raw: bigint;
  /** Raw amount1. */
  amount1Raw: bigint;
}

export type V3PositionMap = Map<string, V3Position[]>;

/**
 * WETH↔ETH canonicalization for the key. DeBank live positions often return the
 * underlying as native `ETH`, while on-chain token0.symbol = `WETH` (e.g.
 * Velodrome WETH/WBTC → live "ETH+WBTC"). Without canon the keys mismatch and
 * the override does not park the cost basis. Mirrors `normalize` in the override.
 */
function canonSymbol(s: string): string {
  return s.toUpperCase() === "WETH" ? "ETH" : s.toUpperCase();
}

/** Canonical key matching a V3 position to an OpenPosition UI row. */
export function v3PositionKey(args: {
  walletId: string;
  chain: string;
  deploymentId: string;
  symbols: string[];
}): string {
  const sorted = args.symbols.map(canonSymbol).sort();
  return `${args.walletId}|${args.chain}|${args.deploymentId}|${sorted.join("|")}`;
}
