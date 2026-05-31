/**
 * Running weighted-average cost basis по каждому токену на кошельке.
 *
 * Идея: проходим все ops хронологически. Для swap'ов, где OUT-сторона —
 * стейблы, IN-сторона — целевой токен (любой), обновляем средневзвешенную
 * цену:
 *
 *   new_avg = (old_amount × old_avg + stablesPaid) / (old_amount + amountIn)
 *
 * Для расходов (lend_supply, lp_add, stake, transfer_out, swap-out, repay)
 * мы НЕ меняем avg — это price-per-unit, она устойчива к расходам. Меняется
 * только running amount (для самопроверки балансов).
 *
 * Снапшот avgAt(symbol, time) даёт цену на момент времени `time` — нужно
 * чтобы при `lend_supply 0.35 ETH @ 2026-03-05` мы взяли avg, который был
 * актуален на 2026-03-05, а не на сегодня.
 */

import { defillamaCoinKey, priceFromMap } from "./pricing.js";
import { isJunkOp } from "./junk_filter.js";
import { isStableSymbol } from "./protocols.js";
import { isReceiptOfProtocol } from "./token_roles.js";
import type { ClassifiedOp, TokenMovement } from "./types.js";

/**
 * Канонизация символа: убираем wrap-префиксы, чтобы `wXYZ` сматчился с `XYZ`.
 *
 * Bug 2 (O_lll_ABC_lll_O POS-003 wSPYx audit 2026-05-25): чейн-ops содержали
 * `wSPYx` (wrapped Spotify tokenized stock), но Morpho receipt в UI был `SPYx`.
 * Cost basis tracker keyед по `WSPYX` → popup lookup по `SPYX` → 0 matches.
 *
 * Strategy: explicit map для известных асимметричных пар (WETH→ETH сохранил
 * совместимость) + generic strip-w-prefix для остальных wrapped-стилей
 * (wSPYx, wMATIC если бы не был в map'е, etc).
 *
 * Стейблы (USDC, USDT, DAI, …) `w`-префикса не имеют — не затрагиваются.
 * wstETH ≠ stETH (разные токены, не unwrap) — НЕ обрабатывается этим helper'ом:
 * у него длина >1 буквы в lowercase префиксе. Strip только если первая буква
 * lowercase 'w' + следующая буква ОДНА (uppercase) перед остальным upper-частью.
 */
function normalizeSymbol(s: string): string {
  const u = s.toUpperCase();
  if (u === "WETH") return "ETH";
  // Generic w-prefix strip: wXYZ → XYZ если оригинал начинался с lowercase 'w'.
  // Защищаем wstETH / wbETH / wstUSDT: lowercase prefix >1 → не trogан.
  if (s.length > 1 && s[0] === "w" && s[1] === s[1]?.toUpperCase() && s[1] !== s[1]?.toLowerCase()) {
    return s.slice(1).toUpperCase();
  }
  return u;
}

/**
 * USD-стоимость движения по hist-ценам (DefiLlama) с fallback на m.usd
 * (текущая spot от DeBank — менее точная). Стейблы = $1.
 */
function movementUsd(
  m: TokenMovement,
  chain: string,
  time: number,
  histPrices: Map<string, number>,
): number {
  if (m.amount <= 0) return 0;
  if (isStableSymbol(m.symbol)) return m.amount;
  const coin = defillamaCoinKey(chain, m.tokenId, m.symbol);
  if (coin) {
    const hp = priceFromMap(histPrices, coin, time);
    if (hp != null && hp > 0) return m.amount * hp;
  }
  if (m.usd != null && m.usd > 0) return m.usd;
  return 0;
}

interface Snapshot {
  /** unix sec — после применения op с этим временем avg выглядел вот так. */
  time: number;
  avgUsd: number;
  /** Накопленное кол-во актива на момент snapshot — для отладки. */
  amount: number;
}

/**
 * Достать avgUsd на момент `time`. Возвращаем последний snapshot с
 * `snapshot.time <= time`. Если до `time` ещё ничего не было — null.
 */
function lookupAt(snapshots: Snapshot[], time: number): number | null {
  if (snapshots.length === 0) return null;
  // Бинарным поиском найти последний snapshot <= time.
  let lo = 0;
  let hi = snapshots.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (snapshots[mid]!.time <= time) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (result < 0) return null;
  return snapshots[result]!.avgUsd;
}

export class CostBasisTracker {
  /** symbol → история snapshot'ов (хронологически). */
  private history = new Map<string, Snapshot[]>();
  /** symbol → текущее накопленное кол-во. Не учитывается в avg, для отладки. */
  private balance = new Map<string, number>();
  /** symbol → текущее накопленное усреднённое avg (последний snapshot). */
  private current = new Map<string, number>();

  /**
   * Регистрируем покупку: amount X получили за `paidUsd` стейблов.
   *
   * **Кумулятивная средневзвешенная** — не зависит от текущего баланса.
   * Расходы (lend_supply / lp_add / repay / transfer_out) НЕ обнуляют
   * накопленные данные. Это как «история покупок за фиат за всё время»:
   *
   *     avg = Σ всех заплаченных стейблов / Σ всех купленных amount
   */
  buy(symbol: string, amount: number, paidUsd: number, time: number): void {
    const sym = normalizeSymbol(symbol);
    if (amount <= 0 || paidUsd <= 0) return;
    const oldBoughtUsd = this.balance.get(sym + "::paid") ?? 0;
    const oldBoughtAmount = this.balance.get(sym) ?? 0;
    const newBoughtUsd = oldBoughtUsd + paidUsd;
    const newBoughtAmount = oldBoughtAmount + amount;
    const newAvg = newBoughtUsd / newBoughtAmount;
    this.balance.set(sym, newBoughtAmount);
    this.balance.set(sym + "::paid", newBoughtUsd);
    this.current.set(sym, newAvg);
    let arr = this.history.get(sym);
    if (!arr) {
      arr = [];
      this.history.set(sym, arr);
    }
    arr.push({ time, avgUsd: newAvg, amount: newBoughtAmount });
  }

  /** Расход — никак не трогает кумулятивную сумму. Метод оставлен для API. */
  consume(_symbol: string, _amount: number, _time: number): void {
    /* кумулятивный режим: расход не влияет на avg */
  }

  /** avg на момент time (последний snapshot с time <= given). */
  avgAt(symbol: string, time: number): number | null {
    const sym = normalizeSymbol(symbol);
    const arr = this.history.get(sym);
    if (!arr) return null;
    return lookupAt(arr, time);
  }

  /** Текущий avg (последний snapshot). */
  currentAvg(symbol: string): number | null {
    return this.current.get(normalizeSymbol(symbol)) ?? null;
  }

  /** Текущее накопленное кол-во. */
  currentAmount(symbol: string): number {
    return this.balance.get(normalizeSymbol(symbol)) ?? 0;
  }
}

/**
 * Прогнать все ops через трекер.
 *
 * 1. **Swap'ы** со стейблом в OUT и целевым токеном в IN — обновляют avg.
 * 2. **Закрытие LP-позиции** (`lp_remove`): IN-токены приходят с cost basis,
 *    унаследованным от `lp_add`-ов той же позиции (см. `attributeLpCloses`
 *    ниже). Это закрывает дыру: иначе закрытая LP-позиция «теряет» свой
 *    PnL — токены приходят с current spot, и убыток LP не отражается в avg
 *    цене актива.
 * 3. Остальные out (`lend_supply`, `lp_add`, `transfer_out`, …) — расход;
 *    avg при этом не меняется (кумулятивный режим).
 */
export function buildCostBasisTracker(
  ops: ClassifiedOp[],
  histPrices: Map<string, number> = new Map(),
): CostBasisTracker {
  const tracker = new CostBasisTracker();
  const sorted = [...ops].sort((a, b) => a.time - b.time);

  // Pre-pass: для каждого lp_remove заранее посчитаем сколько USD от
  // оригинального депозита позиции должно «приехать» с этим закрытием.
  const lpCloseCost = attributeLpCloses(sorted, histPrices);

  for (const op of sorted) {
    if (op.status === "failed") continue;
    if (isJunkOp(op)) continue; // спам-airdrops/dust/MEV не влияют на cost basis

    if (op.type === "swap") {
      const stableOuts = op.movement.filter(
        (m) => m.direction === "out" && m.isStable && m.amount > 0,
      );
      const nonStableOuts = op.movement.filter(
        (m) => m.direction === "out" && !m.isStable && m.amount > 0,
      );
      const ins = op.movement.filter(
        (m) => m.direction === "in" && m.amount > 0,
      );
      const stableSum = stableOuts.reduce((s, m) => s + m.amount, 0);
      // Bug 1 fix (O_lll_ABC_lll_O POS-003 audit 2026-05-25): non-stable→
      // non-stable swap (ETH→wSPYx) раньше не регистрировал buy на IN-сайде,
      // потому что stableSum=0. Теперь cost = stableSum + Σ(wacAt(out_nonstable))
      // (наша WAC отдаваемого токена — propagates cost basis между активами).
      // Fallback на m.usd если wacAt не известен (gap в истории).
      let nonStableOutCost = 0;
      for (const m of nonStableOuts) {
        const wac = tracker.avgAt(m.symbol, op.time);
        if (wac != null && wac > 0) {
          nonStableOutCost += m.amount * wac;
        } else if (m.usd != null && m.usd > 0) {
          nonStableOutCost += m.usd;
        }
      }
      // PR-G1 (2026-05-25): gas — реальный cost транзакции. Для buy side
      // увеличивает break-even price (накопленный газ за все ops с purchases).
      const gasUsd = op.gasUsd ?? 0;
      const totalCost = stableSum + nonStableOutCost + gasUsd;
      if (totalCost > 0 && ins.length > 0) {
        // Делим оплату пропорционально между приходящими токенами по их amount.
        const totalIn = ins.reduce((s, m) => s + m.amount, 0);
        for (const m of ins) {
          const sharePaid = totalCost * (m.amount / totalIn);
          tracker.buy(m.symbol, m.amount, sharePaid, op.time);
        }
      }
      // Out non-stable (продажа актива): уменьшаем баланс. ВАЖНО: вызываем
      // ПОСЛЕ buy чтобы tracker.avgAt выше получил pre-consume WAC.
      for (const m of nonStableOuts) {
        tracker.consume(m.symbol, m.amount, op.time);
      }
      continue;
    }

    if (op.type === "lp_remove") {
      const attribution = lpCloseCost.get(op.hash);
      if (attribution) {
        // PR-G1: газ unwind tx — distributed pro-rata по amount IN-токенов.
        const gasUsd = op.gasUsd ?? 0;
        const totalAmount = Array.from(attribution.values()).reduce(
          (s, info) => s + info.amount,
          0,
        );
        for (const [sym, info] of attribution) {
          if (info.amount > 0 && info.costUsd > 0) {
            const gasShare = totalAmount > 0 ? gasUsd * (info.amount / totalAmount) : 0;
            tracker.buy(sym, info.amount, info.costUsd + gasShare, op.time);
          }
        }
      }
      // Out (LP-token / NFT) — расход, не меняет avg.
      for (const m of op.movement) {
        if (m.direction === "out" && m.amount > 0) {
          tracker.consume(m.symbol, m.amount, op.time);
        }
      }
      continue;
    }

    // lp_add — ОБА tx (Tx A creator + Tx B fill для async-deposit GMX V2 / GMSOL).
    // Если в op есть IN с protocol-token (receipt — GM/GLV/GLP/aToken) и
    // op связан с парной Tx A через linker (`linkedHash`), регистрируем
    // получение receipt-токена с cost basis = outgoing USD из связанной Tx A.
    // Это даёт корректную WAC для GLV / GM / aToken'ов на кошельке —
    // нужно когда такой токен потом депонируется в ДРУГОЙ протокол
    // (Morpho принимает GLV как collateral) или продаётся.
    if (op.type === "lp_add") {
      const linked = op.linkedHash
        ? sorted.find((o) => o.hash === op.linkedHash)
        : null;
      // Cost для receipt'а возьмём либо из этого же op'а (одно-tx Uni V3 style),
      // либо из связанной Tx A (async-deposit GMX V2 / GMSOL).
      const sourceForCost = linked ?? op;
      // Контекстная проверка: token-role зависит от ПРОТОКОЛА op'а.
      // Для lp_add в GMX V2: GM/GLV = receipt, USDC/ETH = underlying out (cost).
      // Для lp_add (GLV-supply) в Morpho: GLV = underlying out (НЕ receipt),
      // должен учитываться в costUsd как обычный актив.
      const protoId = op.protocol?.id ?? "";
      const isReceiptHere = (m: TokenMovement) =>
        isReceiptOfProtocol(m.symbol, protoId, m.tokenId);
      const costUsd = sourceForCost.movement
        .filter(
          (m) =>
            m.direction === "out" &&
            m.amount > 0 &&
            !isReceiptHere(m) &&
            // Не считаем gas micro-amounts ETH.
            !(
              (m.symbol === "ETH" || m.symbol === "WETH") &&
              m.amount < 0.01 &&
              (m.usd ?? 0) < 100
            ),
        )
        .reduce((s, m) => s + (m.usd ?? 0), 0);

      // Receipt-токен(ы) IN — каждому атрибутируем cost basis пропорционально.
      const recvProto = op.movement.filter(
        (m) =>
          m.direction === "in" &&
          isReceiptHere(m) &&
          m.amount > 0,
      );
      if (recvProto.length > 0 && costUsd > 0) {
        // PR-G1: газ deploy tx → в cost basis позиции receipt'а.
        const gasUsd = op.gasUsd ?? 0;
        const totalCostWithGas = costUsd + gasUsd;
        const totalRecv = recvProto.reduce((s, m) => s + m.amount, 0);
        for (const m of recvProto) {
          const share = (m.amount / totalRecv) * totalCostWithGas;
          tracker.buy(m.symbol, m.amount, share, op.time);
        }
      }
      // Out underlying (USDC/ETH/etc.) — расход, не меняет avg.
      for (const m of op.movement) {
        if (m.direction === "out" && m.amount > 0) {
          tracker.consume(m.symbol, m.amount, op.time);
        }
      }
      continue;
    }

    // Любые остальные out (lend_supply, stake, transfer_out, repay, …)
    // — расход, avg не меняется.
    for (const m of op.movement) {
      if (m.direction === "out" && m.amount > 0) {
        tracker.consume(m.symbol, m.amount, op.time);
      }
    }
  }
  return tracker;
}

/**
 * Атрибуция cost basis от `lp_add` к `lp_remove` по позициям.
 *
 * Ключ позиции — `protocolId|sorted(out-symbols-of-add)`. Это группирует
 * все open/close-события одной LP-позиции (с учётом нескольких добавлений).
 *
 * Двухпроходный алгоритм:
 *   1. Группируем lp_add (deposit USD по hist-ценам) и lp_remove (in-токены
 *      с close-USD по hist-ценам или fallback на m.usd) по позиции.
 *   2. Для каждого lp_remove считаем долю от суммарной USD-стоимости
 *      закрытий → распределяем `Σ deposit_usd × share` между его IN-токенами
 *      пропорционально их USD-весу в этом конкретном закрытии.
 *
 * Для частичных закрытий это даёт пропорциональную атрибуцию: если 50%
 * вышло первым, 50% вторым закрытием — каждое возьмёт половину депозита.
 *
 * Ограничение: позиции одной пары в одном протоколе на одном кошельке
 * объединяются в один пул. Если у тебя одновременно 2 NFT в Uniswap V3
 * WETH/USDC с разными диапазонами — их cost basis будет смешан. Точное
 * разделение требует tokenId, который DeBank в lp_add/lp_remove не отдаёт.
 */
export interface LpCloseAttribution {
  amount: number;
  costUsd: number;
}

/**
 * Публичная обёртка над `attributeLpCloses` — возвращает Map<hash, ...>
 * с атрибутированным cost basis для каждого `lp_remove`. Удобно для UI:
 * показать в Реестре операций, сколько USD протянулось с депозита в этот
 * close.
 */
export function computeLpCloseAttribution(
  ops: ClassifiedOp[],
  histPrices: Map<string, number> = new Map(),
): Map<string, Map<string, LpCloseAttribution>> {
  const sorted = [...ops].sort((a, b) => a.time - b.time);
  return attributeLpCloses(sorted, histPrices);
}

function attributeLpCloses(
  sortedOps: ClassifiedOp[],
  histPrices: Map<string, number>,
): Map<string, Map<string, LpCloseAttribution>> {
  interface CloseInfo {
    hash: string;
    time: number;
    /** {symbol, amount, usd} для каждого IN-движения. */
    ins: { symbol: string; amount: number; usd: number }[];
    totalUsd: number;
  }
  interface Group {
    depositUsd: number;
    closes: CloseInfo[];
  }
  const groups = new Map<string, Group>();

  // Группа = (protocolId, chain). Все lp_add/lp_remove одного протокола на
  // одной сети считаем единой позицией. При выходе по нижней/верхней границе
  // lp_remove возвращает только один из токенов пары, поэтому матч по
  // символам сломал бы группировку.
  function keyForOp(op: ClassifiedOp): string | null {
    if (!op.protocol) return null;
    return `${op.protocol.id}|${op.chain}`;
  }

  // Первый проход: собираем deposit USD и closes по группам.
  for (const op of sortedOps) {
    if (op.status === "failed") continue;
    if (isJunkOp(op)) continue;

    if (op.type === "lp_add") {
      const key = keyForOp(op);
      if (!key) continue;
      const usd = op.movement
        .filter((m) => m.direction === "out" && m.amount > 0)
        .reduce((s, m) => s + movementUsd(m, op.chain, op.time, histPrices), 0);
      if (usd <= 0) continue;
      let g = groups.get(key);
      if (!g) {
        g = { depositUsd: 0, closes: [] };
        groups.set(key, g);
      }
      g.depositUsd += usd;
      continue;
    }

    if (op.type === "lp_remove") {
      const key = keyForOp(op);
      if (!key) continue;
      const insRaw = op.movement.filter(
        (m) => m.direction === "in" && m.amount > 0,
      );
      if (insRaw.length === 0) continue;
      const ins = insRaw.map((m) => ({
        symbol: m.symbol,
        amount: m.amount,
        usd: movementUsd(m, op.chain, op.time, histPrices),
      }));
      const totalUsd = ins.reduce((s, m) => s + m.usd, 0);
      let g = groups.get(key);
      if (!g) {
        g = { depositUsd: 0, closes: [] };
        groups.set(key, g);
      }
      g.closes.push({ hash: op.hash, time: op.time, ins, totalUsd });
    }
  }

  // Второй проход: для каждого close распределяем долю от depositUsd.
  const out = new Map<string, Map<string, LpCloseAttribution>>();
  for (const g of groups.values()) {
    if (g.depositUsd <= 0 || g.closes.length === 0) continue;
    const sumCloseUsd = g.closes.reduce((s, c) => s + c.totalUsd, 0);
    for (const c of g.closes) {
      const share =
        sumCloseUsd > 0 ? c.totalUsd / sumCloseUsd : 1 / g.closes.length;
      const attributedUsd = g.depositUsd * share;
      const perSymbol = new Map<string, LpCloseAttribution>();
      for (const m of c.ins) {
        const tokenShare =
          c.totalUsd > 0 ? m.usd / c.totalUsd : 1 / c.ins.length;
        const cost = attributedUsd * tokenShare;
        const sym = normalizeSymbol(m.symbol);
        const prev = perSymbol.get(sym);
        if (prev) {
          perSymbol.set(sym, {
            amount: prev.amount + m.amount,
            costUsd: prev.costUsd + cost,
          });
        } else {
          perSymbol.set(sym, { amount: m.amount, costUsd: cost });
        }
      }
      out.set(c.hash, perSymbol);
    }
  }
  return out;
}
