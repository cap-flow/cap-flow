/**
 * `LotTracker` — основной класс учёта cost basis через lots.
 *
 * Поддерживает 3 методики потребления:
 *  - **WAC** (default): consume пропорционально из всех лотов по средней цене.
 *    Затем «нормализует» оставшиеся лоты с новой WAC. Это простейшая модель.
 *  - **FIFO**: consume старейших лотов первыми. Каждый лот сохраняет свой
 *    оригинальный costPerUnit. Tax-friendly.
 *  - **LIFO**: consume новейших лотов первыми.
 *
 * Все три модели работают на одной структуре данных (массив Lot per
 * (walletId, symbol)). Разница только в том, какой лот выбирается следующим.
 */

import type {
  AcquireOptions,
  ConsumeOptions,
  ConsumeResult,
  Lot,
  LotConsumption,
  LotMethodology,
} from "./types";

function normalizeSymbol(s: string): string {
  const u = s.toUpperCase();
  return u === "WETH" ? "ETH" : u;
}

function key(walletId: string, symbol: string): string {
  return `${walletId}|${normalizeSymbol(symbol)}`;
}

export class LotTracker {
  /** lots[walletId|SYMBOL] = Lot[] — в хронологическом порядке. */
  private readonly lots = new Map<string, Lot[]>();
  private readonly methodology: LotMethodology;

  constructor(methodology: LotMethodology = "WAC") {
    this.methodology = methodology;
  }

  // ─── Public API ──────────────────────────────────────────────────────

  /**
   * Зарегистрировать новый лот (приобретение токена).
   * Возвращает созданный Lot для дальнейшего использования
   * (например передачи в PositionTracker как event reference).
   */
  acquire(opts: AcquireOptions): Lot {
    if (opts.amount <= 0 || opts.costPerUnitUsd < 0) {
      throw new Error(
        `LotTracker.acquire: invalid amount=${opts.amount} or cost=${opts.costPerUnitUsd}`,
      );
    }
    const lot: Lot = {
      symbol: normalizeSymbol(opts.symbol),
      tokenId: opts.tokenId.toLowerCase(),
      chain: opts.chain,
      amount: opts.amount,
      costPerUnitUsd: opts.costPerUnitUsd,
      acquiredAt: opts.acquiredAt,
      acquiredVia: opts.acquiredVia,
      sourceHash: opts.sourceHash,
      walletId: opts.walletId,
      ...(opts.fmvAtAcquisitionUsd !== undefined && {
        fmvAtAcquisitionUsd: opts.fmvAtAcquisitionUsd,
      }),
    };
    const k = key(opts.walletId, opts.symbol);
    let arr = this.lots.get(k);
    if (!arr) {
      arr = [];
      this.lots.set(k, arr);
    }
    // M4 (2026-05-14): binary-search insert in O(log n) + O(n) splice
    // instead of `push + sort` which was O(n log n) per acquire. For
    // 5000-lot wallets the old approach was ~25M sort ops; this brings
    // it to ~60k. Maintains chronological invariant FIFO/LIFO depend on.
    //
    // Most acquires arrive in time order (ops are pre-sorted upstream),
    // so the binary search lands at the tail in O(1) effectively. The
    // worst case is back-fills (manual fiat annotations).
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid]!.acquiredAt <= opts.acquiredAt) lo = mid + 1;
      else hi = mid;
    }
    arr.splice(lo, 0, lot);
    return lot;
  }

  /**
   * Потребить amount токена. Возвращает список лотов и какая часть из
   * каждого была взята с attributed cost. Используется при swap-out,
   * lend_supply, lp_add (in-side underlying), transfer_out.
   *
   * Если запрошенного amount не хватает — берём что есть, ставим
   * `insufficient: true`. Это нормально для случаев unknown deposits
   * (token transferred from somewhere we didn't track) — cost тогда $0
   * на не-покрытую часть.
   */
  consume(opts: ConsumeOptions): ConsumeResult {
    const k = key(opts.walletId, opts.symbol);
    const arr = this.lots.get(k);
    if (!arr || arr.length === 0 || opts.amount <= 0) {
      return {
        consumed: [],
        totalCostUsd: 0,
        totalAmount: 0,
        insufficient: opts.amount > 0,
      };
    }

    const order = this.pickConsumeOrder(arr);
    const consumed: LotConsumption[] = [];
    let remaining = opts.amount;
    let totalCost = 0;
    let totalAmount = 0;

    // WAC режим: cost-per-unit для consume = текущая running WAC всех лотов
    // (Σ amount × costPerUnit) / Σ amount. Это даёт UI отличие от FIFO/LIFO:
    // в WAC консумируем по средней цене, не по цене конкретного лота.
    let wacCostPerUnit: number | null = null;
    if (this.methodology === "WAC") {
      let totA = 0;
      let totC = 0;
      for (const lot of arr) {
        if (opts.tokenId && lot.tokenId && lot.tokenId !== opts.tokenId.toLowerCase()) continue;
        if (opts.chain && lot.chain !== opts.chain) continue;
        totA += lot.amount;
        totC += lot.amount * lot.costPerUnitUsd;
      }
      wacCostPerUnit = totA > 0 ? totC / totA : null;
    }

    for (const lot of order) {
      if (remaining <= 1e-12) break;
      if (lot.amount <= 1e-12) continue;
      // UCB C12: лоты с пустым tokenId (типичный кейс — lend_withdraw
      // где DeBank не отдаёт underlying contract address) НЕ должны
      // игнорироваться по tokenId-фильтру. Match по symbol+chain
      // достаточно — если лот без tokenId, доверяем что consume на
      // ту же (walletId, symbol) пару — это его. Без C12 supply
      // consume пропускал lend_withdraw лот → cost basis раздут
      // (баг POS-005: $31,558 вместо $30,000).
      if (opts.tokenId && lot.tokenId && lot.tokenId !== opts.tokenId.toLowerCase()) continue;
      if (opts.chain && lot.chain !== opts.chain) continue;
      const take = Math.min(lot.amount, remaining);
      // WAC: консумируем по running average. FIFO/LIFO: по цене конкретного лота.
      const costPerUnit =
        this.methodology === "WAC" && wacCostPerUnit != null
          ? wacCostPerUnit
          : lot.costPerUnitUsd;
      const costPart = take * costPerUnit;
      consumed.push({
        lot,
        amountConsumed: take,
        costAttributedUsd: costPart,
      });
      lot.amount -= take;
      // UCB C11: запоминаем consume чтобы `wacAt(time)` мог восстановить
      // historical amount-at-time (undo future consumes).
      if (!lot.consumes) lot.consumes = [];
      lot.consumes.push({ time: opts.consumedAt, amount: take });
      remaining -= take;
      totalCost += costPart;
      totalAmount += take;
    }

    // M3 (2026-05-14): WAC drift fix.
    //
    // After a WAC consume, lot.amount is decremented but the original
    // costPerUnitUsd stays unchanged on each remaining lot. The sum
    // `Σ amount × costPerUnit` across remaining lots no longer matches
    // "true" residual cost (pre-WAC × residual-amount). Future WAC
    // computes from those stale per-lot prices → numerical drift.
    //
    // Fix: normalize ALL remaining lots' `costPerUnitUsd` to the
    // pre-consume WAC (which mathematically equals the post-consume
    // WAC under proportional consumption). Eliminates drift while
    // preserving FIFO/LIFO chronological order for `currentAvg` /
    // `currentAmount` and audit trail.
    //
    // No-op for FIFO/LIFO — per-lot prices are the source of truth there.
    if (this.methodology === "WAC" && wacCostPerUnit != null && wacCostPerUnit > 0) {
      for (const lot of arr) {
        if (lot.amount <= 1e-9) continue;
        if (opts.tokenId && lot.tokenId && lot.tokenId !== opts.tokenId.toLowerCase()) continue;
        if (opts.chain && lot.chain !== opts.chain) continue;
        (lot as { costPerUnitUsd: number }).costPerUnitUsd = wacCostPerUnit;
      }
    }

    // UCB C11: НЕ удаляем zero-amount lots — они нужны для
    // `wacAt(time)` чтобы восстановить historical amount через
    // `lot.consumes`. `currentAmount` / `currentWac` / `getLots`
    // фильтруют их при чтении.

    return {
      consumed,
      totalCostUsd: totalCost,
      totalAmount,
      insufficient: remaining > 1e-9,
    };
  }

  /**
   * Снимок WAC (weighted-average cost / unit) для (wallet, symbol) на
   * момент `time`. Возвращает null если у пользователя нет этого токена
   * на тот момент.
   *
   * Используется для оценки cost basis при moving-window операциях
   * (lend_supply ETH @ 2026-03-05 → берём ETH WAC накопленный к 03-05).
   */
  wacAt(walletId: string, symbol: string, time: number): number | null {
    const k = key(walletId, symbol);
    const arr = this.lots.get(k);
    if (!arr || arr.length === 0) return null;
    let amount = 0;
    let cost = 0;
    for (const lot of arr) {
      if (lot.acquiredAt > time) break;
      // UCB C11: реконструируем «сколько было в лоте на момент time»,
      // отменяя consumes с c.time >= time (т.е. при query "before this
      // supply" мы хотим видеть состояние ДО самого supply consume).
      // lot.amount — финальный остаток после ВСЕХ consume'ов.
      let undoneFuture = 0;
      if (lot.consumes) {
        for (const c of lot.consumes) {
          if (c.time >= time) undoneFuture += c.amount;
        }
      }
      const amountAtTime = lot.amount + undoneFuture;
      if (amountAtTime <= 0) continue;
      amount += amountAtTime;
      cost += amountAtTime * lot.costPerUnitUsd;
    }
    if (amount <= 0) return null;
    return cost / amount;
  }

  /**
   * Текущий WAC (== wacAt(walletId, symbol, now)).
   * UCB C11: пропускаем zero-amount lots — они хранятся в arr для
   * historical wacAt, но к "сейчас" не относятся.
   */
  currentWac(walletId: string, symbol: string): number | null {
    const k = key(walletId, symbol);
    const arr = this.lots.get(k);
    if (!arr || arr.length === 0) return null;
    let amount = 0;
    let cost = 0;
    for (const lot of arr) {
      if (lot.amount <= 1e-9) continue;
      amount += lot.amount;
      cost += lot.amount * lot.costPerUnitUsd;
    }
    return amount > 0 ? cost / amount : null;
  }

  /**
   * Все ЖИВЫЕ лоты для (wallet, symbol) — для debug / UI отображения.
   * UCB C11: zero-amount lots в array остаются (для historical wacAt),
   * но в UI отдавать их не нужно.
   */
  getLots(walletId: string, symbol: string): readonly Lot[] {
    const arr = this.lots.get(key(walletId, symbol)) ?? [];
    return arr.filter((l) => l.amount > 1e-9);
  }

  /**
   * Текущий накопленный amount для (wallet, symbol).
   */
  currentAmount(walletId: string, symbol: string): number {
    const arr = this.lots.get(key(walletId, symbol));
    if (!arr) return 0;
    return arr.reduce((s, l) => s + l.amount, 0);
  }

  /**
   * Список всех (walletId, symbol) пар у которых есть lots — для
   * batch-операций / диагностики.
   */
  allKeys(): readonly { walletId: string; symbol: string }[] {
    const out: { walletId: string; symbol: string }[] = [];
    for (const k of this.lots.keys()) {
      const [walletId, symbol] = k.split("|");
      if (walletId && symbol) out.push({ walletId, symbol });
    }
    return out;
  }

  // ─── Private ─────────────────────────────────────────────────────────

  private pickConsumeOrder(arr: Lot[]): Lot[] {
    switch (this.methodology) {
      case "FIFO":
        // arr уже отсортирован по acquiredAt asc
        return [...arr];
      case "LIFO":
        return [...arr].reverse();
      case "HIFO":
        // T1.1: Highest-In-First-Out. Берём лоты с наибольшим
        // costPerUnitUsd первыми — это минимизирует gain (cost наибольший
        // → разница с proceeds меньше). Tax-optimal для US Specific ID.
        // Stable sort by acquiredAt asc — детерминированный tie-break при
        // одинаковом cost.
        return [...arr].sort((a, b) => {
          if (b.costPerUnitUsd !== a.costPerUnitUsd) {
            return b.costPerUnitUsd - a.costPerUnitUsd;
          }
          return a.acquiredAt - b.acquiredAt;
        });
      case "WAC":
      default:
        // WAC: consume пропорционально. Эмулируем через "нормализованные" лоты —
        // объединяем в один синтетический лот с running average. Но для
        // audit trail сохраняем оригиналы и consume FIFO-style (всё равно
        // total cost будет одинаковый если все лоты с одинаковым avg).
        // Точная WAC семантика: cost-per-unit consumed = current avg.
        // Реализация: возвращаем оригинальный порядок, но в consume()
        // стоимость каждого take считаем как `take × wac`, не как
        // `take × lot.costPerUnitUsd`.
        return [...arr];
    }
  }
}

/**
 * Создать новый LotTracker с дефолтной WAC методикой.
 */
export function createLotTracker(
  methodology: LotMethodology = "WAC",
): LotTracker {
  return new LotTracker(methodology);
}
