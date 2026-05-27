/**
 * Krystal Cloud API types — subset что мы используем для V3 LP cross-validation
 * и (опционально) как primary source для V3 current state / fees.
 *
 * API doc: https://cloud-api.krystal.app (KC-APIKey header).
 *
 * Только поля что трогает наш adapter — полный response крупнее (≥30 полей).
 * Если Krystal добавит/удалит поля — TypeScript НЕ упадёт на runtime, потому
 * что мы используем optional chaining и тестим на снапшоте.
 */

export interface KrystalToken {
  address: string;
  symbol: string;
  name?: string;
  decimals: number;
  logo?: string;
}

export interface KrystalTokenAmount {
  token: KrystalToken;
  /** Raw uint256 как string (нужен BigInt парсинг). */
  balance: string;
  /** USD price per unit. */
  price?: number;
  /** USD value = balance × price (Krystal pre-computed). */
  value?: number;
}

export interface KrystalPool {
  id: string;
  poolAddress: string;
  poolPrice?: number;
  protocol: {
    key: string;
    name: string;
    factoryAddress?: string;
    logo?: string;
  };
  token0?: KrystalToken;
  token1?: KrystalToken;
}

export interface KrystalChain {
  id: number;
  name: string;
  logo?: string;
  explorer?: string;
}

export interface KrystalPosition {
  chain: KrystalChain;
  pool: KrystalPool;
  ownerAddress: string;
  /** `{NPM_address}-{tokenId}` для V3/V4. */
  id: string;
  tokenAddress?: string;
  /** NFT tokenId как строка (V3/V4). */
  tokenId: string;
  liquidity?: string;
  minPrice?: number;
  maxPrice?: number;
  currentPositionValue: number;
  status?: "IN_RANGE" | "OUT_OF_RANGE" | "CLOSED";
  /** Live token amounts в позиции (после ребалансировки до текущей цены). */
  currentAmounts?: KrystalTokenAmount[];
  /** Token amounts которые юзер положил при mint (минус withdraws). */
  providedAmounts?: KrystalTokenAmount[];
  /** Trading fees: pending = real-time uncollected, claimed = cumulative collected. */
  tradingFee?: {
    pending?: KrystalTokenAmount[];
    claimed?: KrystalTokenAmount[];
  };
  /** Fee APR (percent, e.g. 25 = 25%). */
  feeApr?: number;
  /** PnL net в USD. */
  pnl?: number;
  /** Unix seconds. Когда NFT впервые получила ликвидность (mint). */
  openedTime?: number;
  /** Performance bundle. Krystal считает на своей стороне. */
  performance?: {
    /** Σ historical USD всех IncreaseLiquidity (Krystal authoritative для V3). */
    totalDepositValue?: number;
    /** Σ historical USD всех DecreaseLiquidity (snято из позиции). */
    totalWithdrawValue?: number;
    pnl?: number;
    impermanentLoss?: number;
    returnOnInvestment?: number;
  };
}
