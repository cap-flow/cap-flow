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

import type {
  KrystalPosition,
  KrystalTokenAmount,
  KrystalTransaction,
} from "./types.js";

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
 * 2026-05-27 (VolnyySanya audit): включаем cost-basis fields
 * (`totalDepositValue`, `openedTime`, `providedTokens`) — Krystal становится
 * PRIMARY для startUsd / openedAt V3 LP. Причина: UCB cost basis на новых
 * кошельках без CEX-синка / cross-wallet связи даёт мусор (silent fallback
 * на lot tracker WAC). Krystal индексирует IncreaseLiquidity напрямую с RPC
 * — supply/decrease/USD-at-block у него точные. Claimed fees ОСТАЮТСЯ UCB+PR-2
 * (lex@ audit 2026-05-25: Krystal claimed unreliable, $271 real → $107 Krystal).
 */
export interface KrystalV3Summary {
  tokenId: string;
  chainCode: string;
  protocolKey: string;
  pair: [string, string];
  status: KrystalPosition["status"];
  /** Lowercased EVM owner address — нужен для wallet-scoped fallback match. */
  ownerAddress: string;
  /** Lowercased V3 pool address — uniq идентификатор для disambiguation. */
  poolAddress: string;
  /**
   * NonfungiblePositionManager (NPM) address для этого NFT. Krystal даёт
   * в `position.tokenAddress`. Используется для построения /transactions
   * endpoint path: `/v1/positions/{chainId}/{npm}-{tokenId}/transactions`.
   */
  npmAddress: string;
  /** Live position value (USD), authoritative. */
  currentUsd: number;
  currentTokens: TokenBreakdown[];
  /** Real-time uncollected fees (USD). */
  pendingFeeUsd: number;
  pendingFeeTokens: TokenBreakdown[];
  /** Lifetime collected fees (USD) — pool-level Collect events. */
  claimedFeeUsd: number;
  claimedFeeTokens: TokenBreakdown[];
  /** Initial provided amounts (mint - withdraws) — cost-basis side. */
  providedTokens: TokenBreakdown[];
  /** Unix seconds NFT mint event. `null` если Krystal не отдал. */
  openedTime: number | null;
  /**
   * Σ historical USD всех IncreaseLiquidity events. `null` если Krystal
   * не отдал. Это authoritative `startUsd` для V3 LP — не зависит от
   * UCB lot tracker / CEX sync / cross-wallet.
   */
  totalDepositValue: number | null;
  /** Σ historical USD всех DecreaseLiquidity events. `null` если не отдал. */
  totalWithdrawValue: number | null;
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

  // 2026-05-27 (lex@ audit): Krystal `currentPositionValue` = Σ token values
  // + Σ pending fees (их «total position TVL including uncollected fees»).
  // У нас в UI pending fees отдельной колонкой FEE → если использовать
  // `currentPositionValue` как currentUsd, pending fees двойным счётом
  // попадут и в «Текущая $» и в «FEE» → пользователь видит inflated
  // currentUsd на ~1-2%.
  //
  // Поэтому currentUsd = Σ currentTokens.usd (just tokens in LP сейчас,
  // без uncollected fees). Pending fees продолжают показываться отдельно
  // через feesUsd (= summary.pendingFeeUsd).
  const currentUsdFromTokens = currentTokens.reduce((s, t) => s + (t.usd ?? 0), 0);

  return {
    tokenId: p.tokenId,
    chainCode: chainCodeFor(p.chain),
    protocolKey: p.pool.protocol.key,
    pair: [sym0, sym1],
    status: p.status,
    ownerAddress: (p.ownerAddress ?? "").toLowerCase(),
    poolAddress: (p.pool.poolAddress ?? "").toLowerCase(),
    npmAddress: (p.tokenAddress ?? "").toLowerCase(),
    currentUsd: currentUsdFromTokens,
    currentTokens,
    pendingFeeUsd: sumUsd(p.tradingFee?.pending),
    pendingFeeTokens: pendingTokens,
    claimedFeeUsd: sumUsd(p.tradingFee?.claimed),
    claimedFeeTokens: claimedTokens,
    providedTokens,
    openedTime: typeof p.openedTime === "number" && p.openedTime > 0 ? p.openedTime : null,
    totalDepositValue:
      typeof p.performance?.totalDepositValue === "number" && p.performance.totalDepositValue > 0
        ? p.performance.totalDepositValue
        : null,
    totalWithdrawValue:
      typeof p.performance?.totalWithdrawValue === "number" && p.performance.totalWithdrawValue >= 0
        ? p.performance.totalWithdrawValue
        : null,
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

/* ─────────────────── Krystal transactions adapter ─────────────────── */

/**
 * Структура соответствующая `OpenPosition.feesClaimedHistory[]` element.
 * Дублируем (а не импортируем из open_positions.ts) чтобы adapter
 * оставался без зависимости от portfolio layer.
 */
export interface ClaimedFeeEntry {
  time: number;
  hash: string;
  usd: number;
  positionUsdAtClaim?: number;
  daysSincePrev?: number;
  aprPeriod?: number;
  tokensReceived?: { symbol: string; amount: number; usd: number }[];
}

/**
 * Суммарная сводка по transactions endpoint.
 *
 * 2026-05-27 (VolnyySanya audit): Krystal `/positions/{chainId}/{nft}/
 * transactions` отдаёт authoritative per-tx breakdown с historical
 * USD prices at block time. Используем для:
 *   - `feesClaimedHistory[]` ← COLLECT_FEE events
 *   - `feesClaimedUsd` ← Σ COLLECT_FEE.value
 *   - cross-check `totalDepositValue` / `totalWithdrawValue` (опционально)
 *
 * Это **полностью заменяет** UCB+PR-2 split-механику для V3 LP (которая
 * была approximate в matched-path и broken в fallback-path).
 */
export interface KrystalTransactionsSummary {
  /** Per-tx COLLECT_FEE history, отсортирована oldest→newest. */
  claimedHistory: ClaimedFeeEntry[];
  /** Σ всех COLLECT_FEE.value (USD historical). */
  claimedTotalUsd: number;
  /** Кол-во DEPOSIT events (для debug / cross-check). */
  depositCount: number;
  /** Кол-во WITHDRAW events. */
  withdrawCount: number;
  /** Все типы events что встретились (для debug). */
  eventTypes: string[];
  /**
   * Σ всех DEPOSIT events' USD value at block time (historical pricing).
   * 2026-05-27 (MMaksimuk POS-001/002 audit): это **authoritative startUsd**
   * для V3/V4 LP — то что user реально заплатил в USD на момент каждого
   * deposit'а. Krystal `/positions.performance.totalDepositValue` оказался
   * unreliable:
   *   - V4 ARB indexer удваивает providedAmounts (POS-001: real $1,749 →
   *     /positions $3,499)
   *   - providedAmounts.value использует current spot × current balance, а
   *     не historical at-deposit, что для volatile tokens даёт mismatch
   *     (POS-002 COPXon: real $425 → /positions $373).
   *
   * `/transactions DEPOSIT.totalUsd` использует block-time pricing (oracle/
   * slot0 на момент tx) — это **istorical cost basis byte-в-byte**.
   */
  depositTotalUsd: number;
  /** Σ всех WITHDRAW events' USD value at block time (для net cost basis). */
  withdrawTotalUsd: number;
}

function entryUsd(entries: KrystalTransaction["transactions"]): number {
  if (!entries) return 0;
  return entries.reduce((s, t) => s + (t.tokenWithValue?.value ?? 0), 0);
}

function entryTokens(
  entries: KrystalTransaction["transactions"],
): { symbol: string; amount: number; usd: number }[] {
  if (!entries) return [];
  return entries
    .map((t) => {
      const tok = t.tokenWithValue?.token;
      const balance = t.tokenWithValue?.balance ?? "0";
      const decimals = tok?.decimals ?? 18;
      let amount = 0;
      try {
        amount = Number(BigInt(balance)) / 10 ** decimals;
      } catch {
        amount = 0;
      }
      return {
        symbol: tok?.symbol ?? "?",
        amount,
        usd: t.tokenWithValue?.value ?? 0,
      };
    })
    .filter((t) => t.amount > 0 || t.usd > 0);
}

/**
 * Конвертировать Krystal transactions array → claimed fee history + summary.
 *
 * COLLECT_FEE events:
 *   - sorted oldest → newest по blockTime
 *   - aprPeriod / positionUsdAtClaim / daysSincePrev НЕ заполняем
 *     (для этого нужна historical position USD value, которой у нас нет
 *     без отдельных запросов). UI fallback'нется на «—» в этих полях,
 *     основные usd/time/tokens — authoritative.
 */
export function krystalTransactionsToSummary(
  txs: readonly KrystalTransaction[],
): KrystalTransactionsSummary {
  const collects: ClaimedFeeEntry[] = [];
  let depositCount = 0;
  let withdrawCount = 0;
  let depositTotalUsd = 0;
  let withdrawTotalUsd = 0;
  const eventTypes = new Set<string>();
  for (const tx of txs) {
    eventTypes.add(tx.type);
    if (tx.type === "COLLECT_FEE") {
      collects.push({
        time: tx.blockTime,
        hash: tx.txHash,
        usd: entryUsd(tx.transactions),
        tokensReceived: entryTokens(tx.transactions),
      });
    } else if (tx.type === "DEPOSIT") {
      depositCount++;
      depositTotalUsd += entryUsd(tx.transactions);
    } else if (tx.type === "WITHDRAW") {
      withdrawCount++;
      withdrawTotalUsd += entryUsd(tx.transactions);
    }
  }
  // Sort oldest → newest (UI рендерит в хронологическом порядке).
  collects.sort((a, b) => a.time - b.time);
  // Recompute daysSincePrev для UI который ожидает это поле.
  for (let i = 1; i < collects.length; i++) {
    const prev = collects[i - 1]!;
    const cur = collects[i]!;
    cur.daysSincePrev = (cur.time - prev.time) / 86400;
  }
  return {
    claimedHistory: collects,
    claimedTotalUsd: collects.reduce((s, e) => s + e.usd, 0),
    depositCount,
    withdrawCount,
    eventTypes: Array.from(eventTypes),
    depositTotalUsd,
    withdrawTotalUsd,
  };
}
