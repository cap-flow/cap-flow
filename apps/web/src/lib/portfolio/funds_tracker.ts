/**
 * FundsTracker — отслеживает «происхождение» каждого токена (taint-tracking).
 *
 * Каждый токен в кошельке состоит из лотов (FIFO). Каждый лот помечен:
 *   - own       — свои деньги (зашедшие через CEX, заработанные)
 *   - borrowed  — заёмные (под коллатерал в lending-протоколе)
 *
 * Тег наследуется через swap, bridge и любые преобразования. Когда
 * ты открываешь позицию, мы знаем точное соотношение own/borrowed,
 * которое в неё ушло — даже если деньги путешествовали через несколько
 * свопов и мостов между сетями.
 */

export type FundType = "own" | "borrowed";

interface FundLot {
  amount: number;
  fundType: FundType;
  /** Имя протокола, выдавшего займ (для borrowed). */
  borrowSource: string | null;
  /** Идентификатор операции loan_take в нашем учёте (для связки). */
  borrowOpId: string | null;
}

export interface ConsumeResult {
  ownAmount: number;
  borrowedAmount: number;
  /** 0..1 — доля заёмных в потреблённой сумме. */
  borrowedShare: number;
  /** Если есть заёмные — имя протокола-источника (первого). */
  borrowedSource: string | null;
  /** id loan_take операции для связки. */
  borrowedOpId: string | null;
}

const TOLERANCE = 1e-9;

/** Транзит для bridge_out → bridge_in. */
interface BridgeTransit {
  token: string;
  amount: number;
  time: number;
  composition: ConsumeResult;
}

const BRIDGE_AMOUNT_TOLERANCE = 0.05;     // ±5% на разницу до/после моста
const BRIDGE_TIME_WINDOW_SEC = 60 * 60;   // ±60 минут на матчинг

export class FundsTracker {
  private lots = new Map<string, FundLot[]>();
  private transit: BridgeTransit[] = [];

  /* ----------------------------- core ----------------------------------- */

  private getLots(symbol: string): FundLot[] {
    let arr = this.lots.get(symbol);
    if (!arr) {
      arr = [];
      this.lots.set(symbol, arr);
    }
    return arr;
  }

  /** Положить деньги: приход с биржи, перевод в кошелёк, награды. */
  receive(
    symbol: string,
    amount: number,
    fundType: FundType = "own",
    source: string | null = null,
    opId: string | null = null,
  ): void {
    if (amount <= TOLERANCE) return;
    this.getLots(symbol).push({
      amount,
      fundType,
      borrowSource: source,
      borrowOpId: opId,
    });
  }

  /** FIFO-расход; возвращает композицию того, что ушло. */
  consume(symbol: string, amount: number): ConsumeResult {
    const arr = this.getLots(symbol);
    let remaining = amount;
    let own = 0;
    let borrowed = 0;
    let borrowedSource: string | null = null;
    let borrowedOpId: string | null = null;

    while (remaining > TOLERANCE && arr.length > 0) {
      const head = arr[0]!;
      const take = Math.min(head.amount, remaining);
      if (head.fundType === "own") {
        own += take;
      } else {
        borrowed += take;
        if (!borrowedSource) {
          borrowedSource = head.borrowSource;
          borrowedOpId = head.borrowOpId;
        }
      }
      head.amount -= take;
      remaining -= take;
      if (head.amount < TOLERANCE) arr.shift();
    }

    const total = own + borrowed;
    return {
      ownAmount: own,
      borrowedAmount: borrowed,
      borrowedShare: total > 0 ? borrowed / total : 0,
      borrowedSource,
      borrowedOpId,
    };
  }

  /* ----------------------------- swap ----------------------------------- */

  /**
   * Swap: тратим cur1, получаем cur2. Композиция тэга наследуется
   * пропорционально (если 70% было own → 70% полученного — own).
   */
  swap(
    fromSymbol: string,
    fromAmount: number,
    toSymbol: string,
    toAmount: number,
  ): ConsumeResult {
    const composition = this.consume(fromSymbol, fromAmount);
    if (toAmount <= TOLERANCE) return composition;

    const totalConsumed = composition.ownAmount + composition.borrowedAmount;
    if (totalConsumed <= TOLERANCE) {
      // Если consume ничего не нашёл (edge-case), считаем приход own.
      this.receive(toSymbol, toAmount, "own");
      return composition;
    }

    if (composition.ownAmount > 0) {
      const ownShare = composition.ownAmount / totalConsumed;
      this.receive(toSymbol, toAmount * ownShare, "own");
    }
    if (composition.borrowedAmount > 0) {
      const borrowedShare = composition.borrowedAmount / totalConsumed;
      this.receive(
        toSymbol,
        toAmount * borrowedShare,
        "borrowed",
        composition.borrowedSource,
        composition.borrowedOpId,
      );
    }
    return composition;
  }

  /* ----------------------------- bridges -------------------------------- */

  /**
   * Bridge out: расходуем токен, паркуем композицию в transit-очередь.
   * bridge_in потом подхватит её и восстановит метку.
   */
  bridgeOut(symbol: string, amount: number, time: number): ConsumeResult {
    const composition = this.consume(symbol, amount);
    this.transit.push({ token: symbol, amount, time, composition });
    return composition;
  }

  /**
   * Bridge in: ищем парный bridge_out по (token, ±5% сумма, ±60 мин).
   * Если нашли — наследуем композицию, иначе считаем own.
   */
  bridgeIn(symbol: string, amount: number, time: number): ConsumeResult | null {
    const idx = this.transit.findIndex(
      (b) =>
        b.token === symbol &&
        Math.abs(b.amount - amount) / Math.max(b.amount, TOLERANCE) <
          BRIDGE_AMOUNT_TOLERANCE &&
        Math.abs(b.time - time) < BRIDGE_TIME_WINDOW_SEC,
    );
    if (idx === -1) {
      this.receive(symbol, amount, "own");
      return null;
    }
    const transit = this.transit.splice(idx, 1)[0]!;
    const c = transit.composition;
    const total = c.ownAmount + c.borrowedAmount;
    if (total <= TOLERANCE) {
      this.receive(symbol, amount, "own");
      return c;
    }
    if (c.ownAmount > 0) {
      this.receive(symbol, amount * (c.ownAmount / total), "own");
    }
    if (c.borrowedAmount > 0) {
      this.receive(
        symbol,
        amount * (c.borrowedAmount / total),
        "borrowed",
        c.borrowedSource,
        c.borrowedOpId,
      );
    }
    return c;
  }

  /* ----------------------------- repay ---------------------------------- */

  /**
   * Repay: гасим долг. Сначала выгребаем borrowed-лоты (логично — мы возвращаем
   * именно заёмные), потом, если не хватило, лезем в own.
   */
  repay(symbol: string, amount: number): ConsumeResult {
    const arr = this.getLots(symbol);
    // Стабильная сортировка: borrowed первыми.
    arr.sort((a, b) =>
      a.fundType === b.fundType ? 0 : a.fundType === "borrowed" ? -1 : 1,
    );
    return this.consume(symbol, amount);
  }

  /* ----------------------------- intro --------------------------------- */

  /** Заглянуть в текущую композицию баланса по токену (без расхода). */
  inspect(symbol: string): { own: number; borrowed: number; total: number } {
    const arr = this.lots.get(symbol) ?? [];
    let own = 0;
    let borrowed = 0;
    for (const l of arr) {
      if (l.fundType === "own") own += l.amount;
      else borrowed += l.amount;
    }
    return { own, borrowed, total: own + borrowed };
  }
}
