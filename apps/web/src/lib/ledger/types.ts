/**
 * Доменная модель ручного учёта Capflow.
 *
 * Соответствует структуре экспорта `capflow-export.json` 1-в-1, чтобы
 * импорт был лосслесс. Любая будущая авто-генерация (из блокчейна) тоже
 * должна укладываться в эти типы.
 */

export type ManualOpType =
  | "buy"          // конвертация одного актива в другой (P2P, swap)
  | "open"         // открытие позиции в проекте
  | "close"        // закрытие позиции — деньги вернулись
  | "loan_take"    // взятие займа под коллатерал
  | "loan_return"  // возврат долга или коллатерала
  | "dividend"     // сбор наград/процентов по позиции
  | "fee"          // комиссия сети
  | "reinvest"     // реинвест дивидендов в новую позицию
  | "bridge";      // перевод одного актива из одной сети в другую

export type ManualPosType = "Лендинг" | "Пул ликвидности" | "Депозит" | string;
export type ManualFunds = "own" | "borrowed" | null;
export type ManualReturnType = "collateral" | "debt" | null;
export type ManualSource = "manual" | "auto";

/**
 * Универсальная запись операции — все поля как в экспорте.
 * Не все поля заполняются для каждого type'а; это "wide table".
 */
export interface ManualOp {
  id: string;            // "OP-037" / "BC-001" (для авто-сгенерённых)
  date: string;          // YYYY-MM-DD
  type: ManualOpType;
  source: ManualSource;

  from: string | null;   // "p2p" / "Trust Wallet" / "Fluid" / null
  to: string | null;

  // Экономика сделки
  cur1: string | null;
  amount1: number | null;
  cur2: string | null;
  amount2: number | null;
  rate: number | null;     // amount1 / amount2 (или наоборот, в зависимости от направления)
  price: number | null;    // USD-цена операции в момент
  avgPrice: number | null; // средневзвешенная цена накопительно по cur2

  // Позиция
  posType: ManualPosType | null;
  funds: ManualFunds;

  // Заём
  loanRate: number | null;        // % ставка на позиции, в которую идут заёмные
  loanRateTake: number | null;    // % ставка займа в источнике
  loanFrom: string | null;        // имя протокола-источника займа
  loanPosId: string | null;       // OP-id родительского коллатерала
  loanLtv: number | null;
  loanLiqPct: number | null;
  loanLiqPrice: number | null;
  loanCollateralUsd: number | null;

  // LP
  lpVersion: string | null;
  lpPair: string | null;
  lpPriceLow: number | null;
  lpPriceHigh: number | null;
  lpPriceOpen: number | null;
  lpFeeTier: number | null;
  lpNftId: string | null;

  // Сеть
  network: string | null;          // "Arbitrum", "Solana", "Ethereum"
  commissionNetwork: number | null;
  /** USD-стоимость газа этой tx (DeBank / Helius). */
  gasUsd?: number | null;

  // Закрытие
  closeTokenAmount: number | null;
  closeCur2: string | null;
  closeAmount2: number | null;

  // Реинвест и возврат
  reinvestPosId: string | null;
  returnPosId: string | null;
  returnType: ManualReturnType;

  // Прочее
  direction: "long" | "short" | null;
  comment: string;
  dividendFunds: ManualFunds | null;
  /** 0..1 — доля заёмных средств в позиции (0 = свои, 1 = на 100% кредит). */
  borrowedShare?: number | null;
}

/* -------------------------- агрегаты учёта -------------------------------- */

export interface ImportedLedger {
  account: { id: string; name: string; createdAt: number };
  operations: ManualOp[];
  wallets: string[];
  projects: string[];
  tokens: string[];
  importedAt: number;
}

/**
 * Позиция как агрегат: открытие + связанные события.
 * Стройм пост-фактум из ManualOp[] для красивого UI.
 */
export interface LedgerPosition {
  id: string;            // = id операции open
  openOp: ManualOp;
  closeOp: ManualOp | null;
  isOpen: boolean;
  project: string;       // openOp.to
  posType: ManualPosType | null;
  funds: ManualFunds;
  network: string | null;
  // Связи
  loans: ManualOp[];     // loan_take с loanPosId === this.id
  loanReturns: ManualOp[]; // loan_return с returnPosId === this.id
  dividends: ManualOp[]; // dividends с упоминанием this.id в comment
  reinvests: ManualOp[]; // reinvest c reinvestPosId === this.id
  // Экономика
  initialAmount: number;
  initialCurrency: string;
  initialUsd: number | null;
  totalDividendsUsd: number; // приближение, считается по amount1 для USDC/USDT
  // Заём (агрегат)
  totalBorrowedUsd: number;
  totalReturnedCollateralAmount: number;
}

export interface LedgerSummary {
  startingCapitalRub: number;       // Σ amount1 у buy'ов где cur1==RUB
  startingCapitalUsdt: number;      // Σ amount2 у buy'ов RUB→USDT
  avgRubPerUsdt: number | null;     // weighted
  feesByNetwork: Record<string, number>;
  positionsCount: number;
  openPositionsCount: number;
  closedPositionsCount: number;
}
