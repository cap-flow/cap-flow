/**
 * Финансовая категория операции — то, во что DeBank "send/receive/approve"
 * превращается после классификатора.
 */
export type OpType =
  | "deposit_fiat" // приход стейблов с CEX/банка
  | "withdraw_fiat" // отправка стейблов на CEX
  | "transfer_in" // приход с другого своего кошелька
  | "transfer_out" // отправка на свой кошелёк
  | "swap" // спот-обмен на DEX
  | "lend_supply" // внёс коллатерал в lending
  | "lend_withdraw" // забрал коллатерал
  | "borrow" // взял займ
  | "repay" // погасил займ
  | "lp_add" // добавил ликвидность
  | "lp_remove" // удалил ликвидность
  | "stake" // стейкинг (Lido, Rocket, eETH…)
  | "unstake"
  | "claim_rewards" // клейм rewards
  | "perp_open"
  | "perp_close"
  | "bridge_in"
  | "bridge_out"
  | "approve"
  | "failed"
  | "gas_topup"
  | "unknown";

/** Категория протокола для распознавания типа операции. */
export type ProtocolCategory =
  | "lending"
  | "dex"
  | "lp" // когда явно про LP
  | "staking"
  | "restaking"
  | "yield"
  | "perp"
  | "bridge"
  | "cdp"
  | "other";

export interface ProtocolInfo {
  id: string;
  name: string;
  category: ProtocolCategory;
}

/* ----------------------------- классифицированная op ---------------------- */

export interface ClassifiedOp {
  seq: number;
  hash: string;
  chain: string;
  time: number;
  status: "ok" | "failed";
  type: OpType;
  protocol: ProtocolInfo | null;
  movement: TokenMovement[];
  netUsd: number;
  gasUsd: number | null;
  /** Адрес контрагента (то, что не наш кошелёк). */
  counterparty: string | null;
  /**
   * Адрес, который **подписал tx и оплатил газ**. Критично для отличия
   * «я сам кликнул claim» (feePayer = our address) vs «протокол / третья
   * сторона авто-пушнули мне токен» (feePayer = другой адрес → spam/airdrop).
   *
   * EVM — `tx.from_addr` от DeBank.
   * Solana — `tx.feePayer` от Helius.
   */
  feePayer: string | null;
  /** Имя вызванной функции из tx (если DeBank смог её декодировать). */
  fnName: string | null;
  /** Подсказка про approve. */
  approveSpender: string | null;
  approveSymbol: string | null;
  notes?: string[];
  /**
   * Откуда пришла классификация типа операции:
   * - `"explicit"` — Helius/DeBank сами сказали что это SWAP/DEPOSIT/etc.
   *   или сработала эвристика по известной категории протокола.
   * - `"auto"` — сработал generic net-balance fallback классификатора
   *   (mint X ушёл нетто, mint Y пришёл нетто → swap). Это значит протокол
   *   не зарегистрирован в нашем реестре, мы определили операцию эвристикой
   *   и стоит верифицировать.
   * Не выставляется для transfer_in/transfer_out и unknown.
   */
  detection?: "explicit" | "auto";

  /**
   * Хеш парной транзакции в async-deposit/withdraw модели (GMX V2,
   * GMSOL, Flash Trade). Эти протоколы исполняются в ДВУХ tx:
   *   Tx A: пользователь шлёт underlying — sends only, без LP-receipt.
   *   Tx B: keeper выдаёт LP-receipt — receives only, протокол-токен.
   * Линкер `link_async_deposits.ts` находит пары и заполняет это поле
   * в обоих ops. Без линка позиции по разным маркетам одного протокола
   * (GM[BTC] vs GM[ETH] vs GLV[WETH-USDC]) сливаются в одну, а cost basis
   * считается по market-price вместо paid-amount.
   */
  linkedHash?: string;
  /**
   * `tokenId` (mint/contract) LP-receipt'а из ПАРНОЙ транзакции — у Tx A
   * (отправитель) копируем сюда tokenId GM/GLV из Tx B. Это позволяет
   * `posKey()` уникализировать позиции по market-токену даже на стороне
   * Tx A, где сам LP-receipt в movement не присутствует.
   */
  linkedLpTokenId?: string;
  /** Symbol того же LP-receipt'а — для отображения. */
  linkedLpSymbol?: string;
  /**
   * USD-стоимость, которую Tx B (получатель) должен использовать как
   * cost basis для входящего LP-receipt'а — равна `Σ outgoing.usd` из
   * парной Tx A (то есть «за сколько вы реально купили GM», не «рыночная
   * цена GM на момент receipt'а»).
   */
  linkedCostBasisUsd?: number;
}

export interface TokenMovement {
  direction: "in" | "out";
  symbol: string;
  tokenId: string;
  amount: number;
  usd: number | null;
  isStable: boolean;
  isProtocolToken: boolean; // aToken / cToken / LP-token / stETH / …
}

/* ---------------------------- snapshot reducer ---------------------------- */

export interface BalanceLine {
  symbol: string;
  tokenId: string;
  amount: number;
  costBasisUsd: number; // weighted average × amount, в USD
  isStable: boolean;
  /**
   * `true`, если хотя бы одно входящее движение по этому символу пришло
   * без USD-цены (m.usd === null). Типичный случай: airdrop / claim_rewards
   * до того, как DeBank/Helius распознали токен и подтянули котировку.
   * При наличии gap'а realized PnL по последующим продажам этого актива
   * считается приближённо — UI должен показать предупреждение.
   */
  costBasisHasGap?: boolean;
}

export interface LendingPositionLine {
  protocol: ProtocolInfo;
  chain: string;
  /** symbol → нетто внесено (по сумме). + значит залог, - значит выведено больше чем внесено. */
  supplied: Record<string, { amount: number; usd: number }>;
  /** symbol → нетто заём. + значит долг открыт. */
  borrowed: Record<string, { amount: number; usd: number }>;
}

export interface LpPositionLine {
  protocol: ProtocolInfo;
  chain: string;
  /** Совокупно USD внесено (положительный) или выведено (отрицательный). */
  netUsd: number;
  /** Список токенов, которые входили в LP. */
  tokens: string[];
  /**
   * Кумулятивные внесения по каждому токену пары (вход в LP).
   * Нужно для подсчёта Impermanent Loss: при выводе сравним по символам
   * deposited[s].amount × close_price[s] vs withdrawn[s].amount × close_price[s] —
   * разница = IL (без учёта собранных fees, которые приходят как доп. amount
   * сверх депонированного).
   */
  deposited?: Record<string, { amount: number; usd: number }>;
  /** Кумулятивные изъятия по каждому токену пары. */
  withdrawn?: Record<string, { amount: number; usd: number }>;
}

/**
 * Помощник: оценка Impermanent Loss + collected fees для LP-позиции.
 *
 * Логика (упрощённая, для двусторонней пары и закрытых LP):
 *   1. По данным `deposited` строим «корзину депозита» — сколько токенов A и B
 *      и сколько USD это было на момент входа.
 *   2. По `withdrawn` — что забрали (USD на момент выхода).
 *   3. **HODL benchmark**: что было бы, если бы вы просто держали те же
 *      токены (A_amount × A_priceAtClose + B_amount × B_priceAtClose).
 *   4. **IL** = withdrawn_usd_total − HODL_benchmark.
 *      Положительная разница — fees перекрыли IL, отрицательная — IL съел fees.
 *
 * Для расчёта HODL нужны цены закрытия: их берём из withdrawn[s].usd / amount,
 * потому что выход LP происходит по рыночным ценам токенов на этот момент.
 */
export function estimateLpImpermanentLoss(line: LpPositionLine): {
  depositedUsd: number;
  withdrawnUsd: number;
  hodlUsd: number;
  /** withdrawn − hodl. Положительный = fees перекрыли IL, отрицательный = чистый убыток от IL. */
  feesNetIlUsd: number;
} | null {
  if (!line.deposited || !line.withdrawn) return null;
  const depositedSyms = Object.keys(line.deposited);
  if (depositedSyms.length === 0) return null;

  const depositedUsd = Object.values(line.deposited).reduce(
    (s, v) => s + v.usd,
    0,
  );
  const withdrawnUsd = Object.values(line.withdrawn).reduce(
    (s, v) => s + v.usd,
    0,
  );

  // Цены на момент закрытия — выводим из withdrawn (если выводили этот символ).
  const closePriceBySym: Record<string, number> = {};
  for (const [sym, v] of Object.entries(line.withdrawn)) {
    if (v.amount > 0 && v.usd > 0) {
      closePriceBySym[sym] = v.usd / v.amount;
    }
  }

  // HODL benchmark: deposited.amount × close_price.
  let hodlUsd = 0;
  for (const [sym, v] of Object.entries(line.deposited)) {
    const closePrice = closePriceBySym[sym];
    if (closePrice == null) {
      // Не знаем цену закрытия для этого токена — IL не считаем.
      return null;
    }
    hodlUsd += v.amount * closePrice;
  }

  return {
    depositedUsd,
    withdrawnUsd,
    hodlUsd,
    feesNetIlUsd: withdrawnUsd - hodlUsd,
  };
}

export interface StakingPositionLine {
  protocol: ProtocolInfo;
  chain: string;
  /** Чистая сумма staked (LST/LRT-token держится в кошельке). */
  amount: number;
  symbol: string;
  costUsd: number;
}

export interface OpsByType {
  type: OpType;
  count: number;
  netUsd: number; // знак относительно кошелька (in − out)
}

export interface PortfolioSnapshot {
  walletId: string;
  walletAddress: string;
  /** Σ deposit_fiat в USD. */
  startingCapitalUsd: number;
  /** Σ withdraw_fiat в USD (выведено обратно). */
  withdrawnUsd: number;
  /** "На руках" сейчас (cost basis) — может быть приближённо. */
  netInvestedUsd: number; // startingCapital − withdrawn
  /** Газ за всё время. */
  totalGasUsd: number;
  /** Балансы кошелька (нетто in − out по cost basis). */
  walletBalances: BalanceLine[];
  /** Позиции в lending. */
  lendingPositions: LendingPositionLine[];
  /** LP-позиции. */
  lpPositions: LpPositionLine[];
  /** Стейкинг/рестейкинг. */
  stakingPositions: StakingPositionLine[];
  /** Группировка по типам операций — для верхнеуровневой картины. */
  opsByType: OpsByType[];

  /**
   * Реализованный PnL — фиксируется в момент out-движения нон-стейбл актива
   * (продажа в стейбл, swap на другой актив, withdraw_fiat). Формула:
   *   realized += out.usd − wac × out.amount
   * где wac — средневзвешенная USD-стоимость 1 единицы актива на момент
   * списания. Стейблы и protocol-токены (a/c/stETH) не дают realized.
   * Internal-transfers тоже не дают — это перемещение, не продажа.
   */
  realizedPnlUsd: number;
  /** Realized в разбивке: ключ — символ актива, значение — суммарный realized. */
  realizedPnlBySymbol: Record<string, number>;
  /** Realized в разбивке по типу операции (swap / withdraw_fiat / lp_remove …). */
  realizedPnlByOpType: Partial<Record<OpType, number>>;
}
