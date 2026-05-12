/**
 * Per-position timeline — хронология ops которые **сформировали**
 * конкретную open-position.
 *
 * Алгоритм:
 *  1. Для каждой open-position знаем:
 *     - protocol.id, chain
 *     - lpTokenId (адрес pool/receipt) если есть
 *     - mint op.hash для V3 NFT (instanceId)
 *     - opened.time (момент создания)
 *     - supply symbols (для multi-collateral lending)
 *  2. Фильтруем ops по: тот же protocol + chain + opMatchesLpMarket(lpTokenId)
 *     ИЛИ символ из supply/debt матчится.
 *  3. Берём только op'ы ПОСЛЕ opened.time (включая сам open).
 *  4. Игнорируем junk-помеченные.
 *
 * Каждое событие в таймлайне:
 *   - time: timestamp
 *   - kind: 'open' | 'increase' | 'decrease' | 'claim' | 'borrow' | 'repay'
 *   - amounts: list of {symbol, amount, usd}
 *   - tx: hash для drill-down в реестр
 *
 * Используется для UI popup'а позиции — пользователь видит когда и как
 * формировалась его позиция.
 */

import type { OpenPosition } from "./open_positions";
import { isV3LpProtocol } from "./open_positions";
import { isJunkOp } from "./junk_filter";
import type { ClassifiedOp } from "./types";

export interface PositionTimelineEvent {
  /** Unix-time события (op.time). */
  time: number;
  /** Тип события для UI. */
  kind:
    | "open" // первое создание позиции (mint, supply, deposit)
    | "increase" // докинули в позицию (V3 increaseLiquidity, доп. supply)
    | "decrease" // частично вывели (V3 decreaseLiquidity)
    | "close" // полное закрытие
    | "claim" // забрали fee/yield
    | "borrow" // в lending взяли в долг
    | "repay" // в lending погасили долг
    | "other"; // прочее (напр. failed re-open)
  /** Op hash для drill-down. */
  txHash: string;
  /** Полный op для popover details. */
  op: ClassifiedOp;
  /** «Заметная» сумма движения (для одной строки таймлайна). */
  primaryAmount: { symbol: string; amount: number; usd: number } | null;
  /** Все movement'ы op'а с meaningful amount (для drill-down). */
  movements: { symbol: string; amount: number; usd: number; direction: "in" | "out" }[];
}

export interface PositionTimelineSummary {
  events: PositionTimelineEvent[];
  /** Σ deposits в USD (по `m.usd` на момент tx). */
  totalDepositedUsd: number;
  /** Σ withdrawals в USD. */
  totalWithdrawnUsd: number;
  /** Σ claims в USD. */
  totalClaimedUsd: number;
  /** Σ borrows в USD (только если позиция lending). */
  totalBorrowedUsd: number;
  /** Σ repays. */
  totalRepaidUsd: number;
}

const EVENT_TYPES = new Set([
  "lp_add",
  "lp_remove",
  "lend_supply",
  "lend_withdraw",
  "borrow",
  "repay",
  "claim_rewards",
  "stake",
  "unstake",
  "perp_open",
  "perp_close",
]);

/**
 * Возвращает true если op относится к данной позиции.
 *
 * Критерии (любой из):
 *   1. Совпал по lpTokenId (DeBank receipt анкер)
 *   2. Для V3: совпал по op.hash с mint NFT (instanceId)
 *   3. Для V3 без instanceId: совпал по точному symbol pair (sorted normalized)
 *   4. Для не-V3 без lpTokenId: protocol+chain совпал И symbol matched
 *      (любой symbol из supply/debt)
 */
function opMatchesPosition(op: ClassifiedOp, pos: OpenPosition): boolean {
  if (!op.protocol || op.protocol.id !== pos.protocol.id) return false;
  if (op.chain !== pos.chain) return false;

  // V3 short-circuit: instanceId === mint op.hash. Все ops в том же pool
  // считаются ТОЛЬКО при ТОЧНОМ совпадении canonical pair'а supply symbols.
  //
  // КРИТИЧНО: «хоть один общий символ» НЕ годится — WETH/USDC live позиция
  // увидит fee collect из WETH/ARB пула (общий WETH). Нужно exact pair match.
  // Out-of-range V3 (где live supply один токен) — fallback на subset match.
  if (isV3LpProtocol(pos.protocol.name)) {
    if (pos.instanceId && op.hash === pos.instanceId) {
      return true; // сам mint
    }
    const norm = (s: string): string => {
      const u = s.toUpperCase();
      if (u === "WETH") return "ETH";
      if (u === "WBTC") return "BTC";
      if (u === "WMATIC") return "MATIC";
      if (u === "WBNB") return "BNB";
      return u;
    };
    const supplyKey = [...new Set(pos.supplyTokens.map((t) => norm(t.symbol)))]
      .sort()
      .join("+");
    // meaningful op symbols (exclude protocol-tokens, gas dust ETH < 0.01).
    const meaningful = op.movement.filter(
      (m) =>
        m.amount > 0 &&
        !m.isProtocolToken &&
        !(
          (m.symbol === "ETH" || m.symbol === "WETH") &&
          m.amount < 0.01 &&
          (m.usd ?? 0) < 100
        ),
    );
    if (meaningful.length === 0) return false;
    const opKey = [...new Set(meaningful.map((m) => norm(m.symbol)))]
      .sort()
      .join("+");
    // Точное совпадение pair'а — основной случай (in-range mint/increase/
    // decrease/collect показывает оба токена пула).
    if (opKey === supplyKey) return true;
    // Для out-of-range (live supply = только 1 токен) и тех V3 ops где
    // эмитится только 1 токен (one-sided collect): supply ⊂ op (op содержит
    // ВСЕ символы из supply, плюс может быть пустой второй).
    const supplySet = new Set(pos.supplyTokens.map((t) => norm(t.symbol)));
    const opSet = new Set(meaningful.map((m) => norm(m.symbol)));
    if (supplySet.size <= opSet.size) {
      let allIn = true;
      for (const s of supplySet) {
        if (!opSet.has(s)) {
          allIn = false;
          break;
        }
      }
      if (allIn) return true;
    }
    // НЕ матчим если op имеет ЛИШНИЕ символы которых нет в supply
    // (это fee из чужого пула — например WETH/ARB не должна попадать в
    // WETH/USDC позицию, у которой supplySet={ETH,USDC} а opSet={ETH,ARB}).
    return false;
  }

  // Lending / non-V3: матч через symbol any-of supply/debt.
  // Если задан lpTokenId — также проверим что в op есть protocol-token с этим
  // mint'ом (для multi-market protocols).
  const supplySyms = new Set(
    pos.supplyTokens.map((t) => t.symbol.toUpperCase()),
  );
  const debtSyms = new Set(pos.debtTokens.map((t) => t.symbol.toUpperCase()));
  for (const m of op.movement) {
    if (m.amount <= 0) continue;
    const sym = m.symbol.toUpperCase();
    if (supplySyms.has(sym) || debtSyms.has(sym)) return true;
  }
  return false;
}

/** Определяем kind события из op'а. */
function eventKindFromOp(
  op: ClassifiedOp,
  isFirstOpen: boolean,
): PositionTimelineEvent["kind"] {
  if (isFirstOpen) return "open";
  switch (op.type) {
    case "lp_add":
    case "lend_supply":
    case "stake":
    case "perp_open":
      return "increase";
    case "lp_remove":
    case "lend_withdraw":
    case "unstake":
    case "perp_close":
      return "decrease"; // close = «полный вывод» определяется на caller'е
    case "borrow":
      return "borrow";
    case "repay":
      return "repay";
    case "claim_rewards":
      return "claim";
    default:
      return "other";
  }
}

/** Выбираем «заметное» движение для одной строки таймлайна. */
function pickPrimaryMovement(
  op: ClassifiedOp,
): PositionTimelineEvent["primaryAmount"] {
  // Приоритет: meaningful (>$1) movement с максимальной USD-суммой.
  // Ignore protocol-tokens (они receipt'ы, не «суть» движения).
  const candidates = op.movement
    .filter((m) => m.amount > 0 && !m.isProtocolToken && (m.usd ?? 0) > 1)
    .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
  if (candidates.length === 0) {
    // Fallback: любое движение
    const any = op.movement.find((m) => m.amount > 0);
    if (!any) return null;
    return { symbol: any.symbol, amount: any.amount, usd: any.usd ?? 0 };
  }
  const top = candidates[0]!;
  return { symbol: top.symbol, amount: top.amount, usd: top.usd ?? 0 };
}

/**
 * Строит timeline для позиции из реестра ops.
 *
 * @param pos OpenPosition для которой строим timeline
 * @param ops Все ClassifiedOp'ы кошелька (где была эта позиция)
 */
export function buildPositionTimeline(
  pos: OpenPosition,
  ops: ClassifiedOp[],
): PositionTimelineSummary {
  // Фильтр: только matching ops, без junk, после opened.time.
  const opensAt = pos.openedAt ?? 0;
  const relevant = ops
    .filter((op) => op.status !== "failed")
    .filter((op) => !isJunkOp(op))
    .filter((op) => EVENT_TYPES.has(op.type))
    .filter((op) => op.time >= opensAt - 60) // 60 сек запас на clock skew
    .filter((op) => opMatchesPosition(op, pos))
    .sort((a, b) => a.time - b.time);

  const events: PositionTimelineEvent[] = [];
  let firstSeen = true;
  let totalDepositedUsd = 0;
  let totalWithdrawnUsd = 0;
  let totalClaimedUsd = 0;
  let totalBorrowedUsd = 0;
  let totalRepaidUsd = 0;

  for (const op of relevant) {
    const isFirstOpen =
      firstSeen &&
      (op.type === "lp_add" ||
        op.type === "lend_supply" ||
        op.type === "stake" ||
        op.type === "perp_open");
    if (isFirstOpen) firstSeen = false;
    const kind = eventKindFromOp(op, isFirstOpen);
    const primary = pickPrimaryMovement(op);
    const movements = op.movement
      .filter((m) => m.amount > 0)
      .map((m) => ({
        symbol: m.symbol,
        amount: m.amount,
        usd: m.usd ?? 0,
        direction: m.direction,
      }));

    events.push({
      time: op.time,
      kind,
      txHash: op.hash,
      op,
      primaryAmount: primary,
      movements,
    });

    // Aggregates: считаем по out-USD для deposits/repay, in-USD для withdraw/borrow/claim.
    const outUsd = op.movement
      .filter(
        (m) => m.direction === "out" && m.amount > 0 && !m.isProtocolToken,
      )
      .reduce((s, m) => s + (m.usd ?? 0), 0);
    const inUsd = op.movement
      .filter(
        (m) => m.direction === "in" && m.amount > 0 && !m.isProtocolToken,
      )
      .reduce((s, m) => s + (m.usd ?? 0), 0);

    switch (kind) {
      case "open":
      case "increase":
        totalDepositedUsd += outUsd;
        break;
      case "decrease":
      case "close":
        totalWithdrawnUsd += inUsd;
        break;
      case "claim":
        totalClaimedUsd += inUsd;
        break;
      case "borrow":
        totalBorrowedUsd += inUsd;
        break;
      case "repay":
        totalRepaidUsd += outUsd;
        break;
    }
  }

  return {
    events,
    totalDepositedUsd,
    totalWithdrawnUsd,
    totalClaimedUsd,
    totalBorrowedUsd,
    totalRepaidUsd,
  };
}

/** Локализация kind для UI. */
export function timelineKindLabel(kind: PositionTimelineEvent["kind"]): string {
  switch (kind) {
    case "open":
      return "Открытие";
    case "increase":
      return "Внесение";
    case "decrease":
      return "Вывод";
    case "close":
      return "Закрытие";
    case "claim":
      return "Сбор fees";
    case "borrow":
      return "Заём";
    case "repay":
      return "Погашение";
    default:
      return "Прочее";
  }
}
