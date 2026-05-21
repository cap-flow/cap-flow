/**
 * Унифицированная модель учёта cost basis через **lots**.
 *
 * Каждое приобретение токена → новый Lot. Каждое расходование → consume
 * соответствующих lots по выбранной методике (WAC / FIFO / LIFO).
 *
 * Эта модель заменяет два существующих модуля:
 *  - `cost_basis_tracker.ts` — running WAC через snapshots
 *  - `cost_basis_avg.ts` — простой WAC без снапшотов
 *
 * Преимущества:
 *  - **Универсальность**: один API для любых сценариев (swap, lp_add,
 *    transfer_in, airdrop, claim_rewards, lp_remove)
 *  - **Audit trail**: каждый lot хранит `sourceHash` и `acquiredVia`
 *  - **Tax-ready**: FIFO/LIFO переключаются через настройку
 *  - **Cross-protocol**: lot переезжает с одного протокола в другой
 *    без потери cost basis (Phase 5 уровень)
 */

export type AcquiredVia =
  | "buy_with_stable" // swap: stable out, token in
  | "swap" // swap: token A out, token B in
  | "transfer_in" // плавный приход (CEX deposit, external transfer)
  | "claim_rewards" // [legacy] протокольные награды до UCB D6 (cost=market)
  | "received_as_reward" // UCB D6: yield/staking/LP rewards, cost basis = 0
  | "airdrop" // airdrop (cost = 0 по умолчанию)
  | "lp_close" // выход из LP с attributed cost basis
  | "lend_withdraw" // withdraw из lending с накопл. yield
  | "borrow" // занятые средства (cost = 0, но debt!)
  | "borrow_self_loop" // UCB C10: borrow same asset as supplied (Morpho leverage loop) — inherits collateral cost
  | "manual_seed" // ручная разметка стартового капитала пользователем
  | "linked_async_fill" // async-deposit fill (cost из linked Tx A)
  | "bridge_in"; // UCB D5: cross-chain bridge с inherited cost basis

export interface Lot {
  /** Token symbol — нормализован (UPPERCASE, WETH→ETH). */
  readonly symbol: string;
  /** Contract address (lowercase, без chain-prefix) — для cross-network match. */
  readonly tokenId: string;
  /** Chain identifier (eth/arb/base/sol/...). */
  readonly chain: string;
  /** Сколько токена в этом лоте (не consumed). Уменьшается при consume. */
  amount: number;
  /** USD/токен в момент приобретения. Не меняется при partial consume. */
  readonly costPerUnitUsd: number;
  /**
   * UCB C11 (2026-05-20): история всех consume-событий из этого лота —
   * timestamp и сколько было списано. Без неё `wacAt(time)` не может
   * восстановить «сколько токена БЫЛО в лоте на момент `time`» — после
   * full consume `lot.amount = 0` и lot либо удаляется из arr, либо
   * перестаёт вносить вклад в historical WAC. Это приводило к null
   * результату → walker fallback на market price → cost basis раздут
   * (баг artur@gmail.com POS-005: $31,558 вместо $30,000).
   *
   * Push'ится в `consume()`; используется в `wacAt(time)` для undo
   * consumes с `c.time >= time`.
   */
  consumes?: { time: number; amount: number }[];
  /** Когда лот появился (unix sec). */
  readonly acquiredAt: number;
  /** Источник приобретения. */
  readonly acquiredVia: AcquiredVia;
  /** tx hash, который этот lot создал. */
  readonly sourceHash: string;
  /** Wallet ID — лоты разделены по кошелькам. */
  readonly walletId: string;
  /**
   * UCB D6: FMV (fair-market value) в USD на момент приобретения.
   * Заполняется ТОЛЬКО для `received_as_reward` лотов (rewards,
   * staking yield, LP fees), где `costPerUnitUsd = 0` по UCB-методике,
   * но мы сохраняем market-price на момент получения для:
   *   - future income reporting (US-tax: reward FMV = ordinary income)
   *   - аналитики «доход от стейкинга» отдельно от capital gains
   *
   * Для всех остальных `acquiredVia` поле undefined.
   */
  readonly fmvAtAcquisitionUsd?: number;
}

/**
 * Какая часть лотов была "потрачена" в одном `consume()` запросе.
 * Возвращается чтобы вызывающий код мог заэмитить event в PositionTracker
 * с конкретной cost-attribution от каждого исходного приобретения.
 */
export interface LotConsumption {
  readonly lot: Lot;
  /** Сколько именно из этого лота было потрачено. */
  readonly amountConsumed: number;
  /** Сколько USD приходится на эту порцию (= amountConsumed × costPerUnitUsd). */
  readonly costAttributedUsd: number;
}

/**
 * Lot consume methodology — определяет порядок забора лотов при consume.
 *
 * - **WAC**: weighted-average cost. Consume пропорционально из всех лотов
 *   по running average. Стабильно, не зависит от sale-ordering.
 * - **FIFO**: first-in-first-out. Старые лоты first. US-default до 2018,
 *   часто требует regulator'ов где-то.
 * - **LIFO**: last-in-first-out. Новые лоты first. Может minimize gains в
 *   бычьем рынке (если recent buys были по высокой цене).
 * - **HIFO** (Highest-In-First-Out): consume лоты с наибольшим cost basis
 *   первыми. Это **tax-optimal** методология для minimizing capital gains:
 *   реализуем наименьший gain (или наибольший loss). Разрешено в US как
 *   "Specific ID" вариант, в RU/EU — обычно требует явного выбора.
 */
export type LotMethodology = "WAC" | "FIFO" | "LIFO" | "HIFO";

export interface ConsumeResult {
  /** Список лотов и сколько из каждого взято. */
  readonly consumed: LotConsumption[];
  /** Σ costAttributedUsd по всем consumed лотам. */
  readonly totalCostUsd: number;
  /** Σ amountConsumed (= запрошенный amount, если хватило лотов). */
  readonly totalAmount: number;
  /** true если запрошенного amount не хватило в имеющихся лотах. */
  readonly insufficient: boolean;
}

export interface AcquireOptions {
  symbol: string;
  tokenId: string;
  chain: string;
  amount: number;
  costPerUnitUsd: number;
  acquiredAt: number;
  acquiredVia: AcquiredVia;
  sourceHash: string;
  walletId: string;
  /** UCB D6: FMV at receipt — required for `received_as_reward`, optional иначе. */
  fmvAtAcquisitionUsd?: number;
}

export interface ConsumeOptions {
  symbol: string;
  tokenId?: string; // если задан — match по tokenId, иначе по symbol
  chain?: string;
  amount: number;
  consumedAt: number;
  walletId: string;
}
