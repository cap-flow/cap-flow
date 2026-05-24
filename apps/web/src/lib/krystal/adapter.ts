/**
 * Adapter: Krystal Cloud API position → Capflow internal V3 summary.
 *
 * Krystal — external truth source для V3 LP current state, pending fees
 * (real-time через server-side feeGrowth math), claimed fees (через Collect
 * events на pool-level, без principal contamination как у нашего DeBank-
 * derived classifier).
 *
 * Этот adapter НЕ заменяет UCB cost basis (startUsd, cross-protocol/cross-
 * wallet attribution). Только V3 LP current-side данные.
 *
 * Используется:
 *  - PR-K2: cross-validation dev console.warn (diff > 5% vs Capflow → warn)
 *  - PR-K3 (future): primary V3 source за feature flag
 */

import type { KrystalPosition, KrystalTokenAmount } from "./types";

/**
 * Mapping Krystal chain.id → Capflow chain code. Если Krystal добавит
 * новый chain — fallback на их `chain.name.toLowerCase()`.
 */
const CHAIN_ID_TO_CODE: Record<number, string> = {
  1: "eth",
  10: "op",
  56: "bsc",
  137: "matic",
  8453: "base",
  42161: "arb",
  2020: "ron",
};

function chainCodeFor(args: { id: number; name: string }): string {
  return CHAIN_ID_TO_CODE[args.id] ?? args.name.toLowerCase();
}

export interface TokenBreakdown {
  symbol: string;
  /** Human-units amount (already decimal-shifted). */
  amount: number;
  /** USD value at Krystal's price oracle moment. */
  usd: number;
  address: string;
}

/**
 * Canonical V3 LP per-NFT summary derived from Krystal response.
 *
 * Кладётся в Map keyed by tokenId. Capflow matching: OpenPosition с
 * `matchedV3TokenId === summary.tokenId` соответствует этому summary.
 *
 * Намеренно НЕ включаем cost-basis fields (totalDepositValue, providedAmounts
 * с current prices) — для startUsd мы используем UCB lots (более точно для
 * cross-wallet / cross-protocol attribution). Сохраняем `providedTokens`
 * только как cross-check.
 */
export interface KrystalV3Summary {
  tokenId: string;
  chainCode: string;
  protocolKey: string;
  pair: [string, string];
  status: KrystalPosition["status"];
  /** Live position value (USD), authoritative. */
  currentUsd: number;
  currentTokens: TokenBreakdown[];
  /** Real-time uncollected fees (USD). */
  pendingFeeUsd: number;
  pendingFeeTokens: TokenBreakdown[];
  /** Lifetime collected fees (USD) — pool-level Collect events. */
  claimedFeeUsd: number;
  claimedFeeTokens: TokenBreakdown[];
  /** Initial provided amounts (mint - withdraws) для cross-validation. */
  providedTokens: TokenBreakdown[];
}

function amountToHuman(raw: string, decimals: number): number {
  try {
    return Number(BigInt(raw)) / 10 ** decimals;
  } catch {
    return 0;
  }
}

function mapToken(a: KrystalTokenAmount): TokenBreakdown {
  return {
    symbol: a.token.symbol,
    address: a.token.address,
    amount: amountToHuman(a.balance, a.token.decimals),
    usd: a.value ?? 0,
  };
}

function sumUsd(arr: KrystalTokenAmount[] | undefined): number {
  return (arr ?? []).reduce((s, a) => s + (a.value ?? 0), 0);
}

/**
 * Krystal часто отдаёт fee/provided entries с `balance="0"` и без `value`
 * (placeholder для known token но без активности). Для UI / cross-validation
 * полезнее фильтровать — пустые сегменты не несут информации.
 */
function isMeaningful(t: TokenBreakdown): boolean {
  return t.amount > 0 || t.usd > 0;
}

export function krystalToV3Summary(p: KrystalPosition): KrystalV3Summary {
  const currentTokens = (p.currentAmounts ?? []).map(mapToken);
  const pendingTokens = (p.tradingFee?.pending ?? []).map(mapToken).filter(isMeaningful);
  const claimedTokens = (p.tradingFee?.claimed ?? []).map(mapToken).filter(isMeaningful);
  const providedTokens = (p.providedAmounts ?? []).map(mapToken);

  const sym0 = currentTokens[0]?.symbol ?? p.pool.token0?.symbol ?? "?";
  const sym1 = currentTokens[1]?.symbol ?? p.pool.token1?.symbol ?? "?";

  return {
    tokenId: p.tokenId,
    chainCode: chainCodeFor(p.chain),
    protocolKey: p.pool.protocol.key,
    pair: [sym0, sym1],
    status: p.status,
    currentUsd: p.currentPositionValue ?? 0,
    currentTokens,
    pendingFeeUsd: sumUsd(p.tradingFee?.pending),
    pendingFeeTokens: pendingTokens,
    claimedFeeUsd: sumUsd(p.tradingFee?.claimed),
    claimedFeeTokens: claimedTokens,
    providedTokens,
  };
}

/**
 * Helper: построить Map<tokenId, KrystalV3Summary> из массива позиций
 * (несколько wallet'ов / chains merge'аются в один lookup).
 */
export function buildKrystalSummaryMap(
  positions: readonly KrystalPosition[],
): Map<string, KrystalV3Summary> {
  const m = new Map<string, KrystalV3Summary>();
  for (const p of positions) {
    if (!p.tokenId) continue;
    m.set(p.tokenId, krystalToV3Summary(p));
  }
  return m;
}
