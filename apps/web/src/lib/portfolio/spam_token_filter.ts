/**
 * Эвристический фильтр scam-токенов для aggregate analytics
 * («Структура портфеля», asset rollup, total balance pie chart).
 *
 * **Проблема:** DeBank возвращает `live.tokens` для wallet'а **со ВСЕМИ**
 * полученными токенами, включая scam-airdrops (ETHG, AICC, DOG, FT и т.д.).
 * Эти токены имеют DeBank-репортуемую USD-цену (часто inflated wash-trading),
 * что искажает analytics: ETHG с amount=2,000,000 и DeBank-price $0.25 даёт
 * фейковую стоимость $500k → portfolio share 717%.
 *
 * **Сигналы scam-airdrop (применяются как `И`):**
 *
 * 1. `lotTracker` НЕ содержит lot'ов для этого symbol на этом walletId.
 *    Значит токен попал на адрес через **не-классифицированный transfer_in**
 *    (никакого swap/buy/claim не было). Все легитимные токены приобретаются
 *    через какой-то op, который LotTracker фиксирует. Scam просто прилетел.
 *
 * 2. DeBank-репортуемая USD-стоимость > $10. Если < $10 — это просто dust,
 *    не нужно отдельно flag'ать, всё равно filter'ится по minSourceUsd.
 *
 * 3. Symbol НЕ в whitelist основных токенов (BTC/ETH/USDC/USDT/...).
 *    Чтобы не блокировать legit major-tokens которые могли прийти как gift /
 *    cross-wallet transfer без видимого acquisition tx в этом wallet'е.
 *
 * **Что фильтр НЕ ловит** (false negatives, в порядке убывания вероятности):
 *  - Legit token user'а полученный как transfer-in из другого его кошелька,
 *    которого нет в Capflow (out-of-system). Решение: добавить тот wallet.
 *  - Token из off-chain swap (Binance/CEX) переведённый в wallet — обычно
 *    подхватывается CEX inheritance D3. Если CEX не подключен — false-positive.
 *
 * **Альтернатива — `junk_filter.ts`** работает на уровне **операций**:
 *  classifyJunk(op) → junk:scam_airdrop. Но он смотрит только на symbol
 *  patterns (.io, claim, voucher) и пропускает токены вроде "ETHG", "AICC"
 *  которые не match'ат явные scam patterns. Здесь — другой подход через
 *  **отсутствие cost basis trail**, который надёжнее.
 */

import type { LotTracker } from "./lots";

/**
 * Whitelist: токены которые НИКОГДА не помечаются как scam, даже если
 * LotTracker не знает о них (потому что user мог получить их out-of-system
 * и забыть подключить wallet-источник).
 */
const NEVER_SPAM_SYMBOLS = new Set<string>([
  // Major
  "BTC", "WBTC", "TBTC", "CBBTC",
  "ETH", "WETH", "STETH", "WSTETH", "RETH", "CBETH", "WEETH",
  "BNB", "WBNB",
  "SOL", "WSOL", "MSOL", "JITOSOL",
  "MATIC", "WMATIC", "POL",
  "AVAX", "WAVAX",
  // Stables
  "USDC", "USDT", "DAI", "USDE", "SUSDE", "USDS", "FRAX", "LUSD", "GHO",
  "PYUSD", "CRVUSD", "MIM", "USDP", "TUSD", "USDD",
  "USD₮0", "USDC.E", "USDBC", "USDB", "USDX",
  // Wrapped major chain tokens
  "ARB", "OP", "BASE",
  // Major DeFi
  "UNI", "AAVE", "COMP", "MKR", "CRV", "BAL", "LDO", "SNX", "CVX",
  "GMX", "DYDX", "1INCH", "SUSHI", "INJ", "PENDLE", "FLUID",
  // Popular L1/L2
  "LINK", "DOT", "ADA", "ATOM", "OSMO", "TIA",
]);

/**
 * Решает, является ли (walletId, token) пометкой scam-airdrop'а.
 *
 * @param symbol — token symbol из DeBank
 * @param usd — DeBank-репортуемая USD стоимость баланса
 * @param hasLotsInTracker — true если LotTracker имеет хотя бы один lot для
 *   этого (walletId, symbol). Caller вычисляет через `lotTracker.getLots(...)`.
 */
export function isSpamWalletToken(
  symbol: string,
  usd: number,
  hasLotsInTracker: boolean,
): boolean {
  if (!symbol) return true;
  // Dust ниже $10 — не fold'ить в spam-bucket; обычный dust filter справится.
  if (usd < 10) return false;
  // Whitelist — никогда не помечаем.
  if (NEVER_SPAM_SYMBOLS.has(symbol.toUpperCase())) return false;
  // Если LotTracker знает о токене (lot'ы есть) → это легитимная история
  // (swap / claim_rewards / transfer_in от internal wallet / CEX inheritance).
  if (hasLotsInTracker) return false;
  // Нет lots в трекере + значимая USD-стоимость + не whitelisted →
  // высокая вероятность scam-airdrop.
  return true;
}

/**
 * Помогает caller'у эффективно проверить наличие lots для token'а.
 * Возвращает true если LotTracker имеет хотя бы один lot (живой или
 * полностью consumed) для (walletId, symbol).
 *
 * Для wallet-балансов используется `currentAmount` (live balance), а трекер
 * проверяется на наличие любой истории.
 */
export function hasAnyLotsForToken(
  tracker: LotTracker | undefined,
  walletId: string,
  symbol: string,
): boolean {
  if (!tracker) return false;
  // Heuristic: если currentAmount > 0 ИЛИ есть консумированная история
  // (currentWac возвращает не-null) — у токена была какая-то acquisition.
  const amount = tracker.currentAmount(walletId, symbol);
  if (amount > 0) return true;
  const wac = tracker.currentWac(walletId, symbol);
  return wac != null;
}
