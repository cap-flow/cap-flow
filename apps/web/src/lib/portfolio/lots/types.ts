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
  | "claim_rewards" // протокольные награды (LP fees, staking rewards)
  | "airdrop" // airdrop (cost = 0 по умолчанию)
  | "lp_close" // выход из LP с attributed cost basis
  | "lend_withdraw" // withdraw из lending с накопл. yield
  | "borrow" // занятые средства (cost = 0, но debt!)
  | "manual_seed" // ручная разметка стартового капитала пользователем
  | "linked_async_fill"; // async-deposit fill (cost из linked Tx A)

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
  /** Когда лот появился (unix sec). */
  readonly acquiredAt: number;
  /** Источник приобретения. */
  readonly acquiredVia: AcquiredVia;
  /** tx hash, который этот lot создал. */
  readonly sourceHash: string;
  /** Wallet ID — лоты разделены по кошелькам. */
  readonly walletId: string;
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

export type LotMethodology = "WAC" | "FIFO" | "LIFO";

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
}

export interface ConsumeOptions {
  symbol: string;
  tokenId?: string; // если задан — match по tokenId, иначе по symbol
  chain?: string;
  amount: number;
  consumedAt: number;
  walletId: string;
}
