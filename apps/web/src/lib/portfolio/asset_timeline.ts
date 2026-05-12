/**
 * Per-asset timeline — хронология ops которые **сформировали**
 * текущий баланс конкретного токена в кошельке.
 *
 * Отличие от `position_timeline.ts`: здесь фильтруем по символу токена
 * (не по позиции в протоколе). Используется в Cap Wallet popup'е чтобы
 * пользователь увидел свою историю по конкретному активу — когда купил,
 * по какой цене, swap'нул в другое или забрал из позиции.
 *
 * Игнорирует junk-помеченные ops автоматически.
 */

import { isJunkOp } from "./junk_filter";
import { isStableSymbol } from "./protocols";
import type { ClassifiedOp, TokenMovement } from "./types";

/** Нормализуем символ для матчинга (WETH→ETH, WBTC→BTC, USD₮0→USDT). */
function normSym(s: string): string {
  const u = s.toUpperCase();
  if (u === "WETH") return "ETH";
  if (u === "WBTC") return "BTC";
  if (u === "WMATIC") return "MATIC";
  if (u === "WBNB") return "BNB";
  if (u === "WSOL") return "SOL";
  if (u === "USD₮0" || u === "USDT0") return "USDT";
  return u;
}

export interface AssetTimelineEvent {
  time: number;
  /** Тип события (swap_in / swap_out / supply / withdraw / borrow / repay / transfer / claim / airdrop). */
  kind:
    | "buy" // получили токен в swap'е (пришёл out из стейбла или другого)
    | "sell" // отдали токен в swap'е
    | "supply" // отдали в DeFi-позицию
    | "withdraw" // забрали из DeFi-позиции
    | "claim" // получили как награду
    | "airdrop" // получили как airdrop (transfer_in без swap)
    | "transfer_in"
    | "transfer_out"
    | "borrow"
    | "repay"
    | "other";
  txHash: string;
  chain: string;
  /** Direction для отображения (in/out). */
  direction: "in" | "out";
  /** Кол-во и USD-стоимость движения по этому символу. */
  amount: number;
  usd: number;
  /** Цена за единицу актива на момент tx (m.usd / m.amount). */
  pricePerUnit: number | null;
  /** Контрагент / протокол если есть. */
  counterparty: string | null;
  protocol: string | null;
}

export interface AssetTimelineSummary {
  symbol: string;
  events: AssetTimelineEvent[];
  /** Σ amount купленных (in от swap/airdrop/claim). */
  totalBought: number;
  totalBoughtUsd: number;
  /** Σ amount проданных (out в swap). */
  totalSold: number;
  totalSoldUsd: number;
  /** Σ amount supplied в DeFi. */
  totalSupplied: number;
  /** Σ amount withdrawn из DeFi. */
  totalWithdrawn: number;
  /** Текущий баланс (как в DeBank). */
  currentAmount: number;
  /** Cumulative WAC (USD per unit). */
  weightedAvgPrice: number | null;
}

/** Определяем kind события по op.type и направлению movement'а. */
function eventKind(
  op: ClassifiedOp,
  m: TokenMovement,
): AssetTimelineEvent["kind"] {
  switch (op.type) {
    case "swap":
      return m.direction === "in" ? "buy" : "sell";
    case "lp_add":
    case "lend_supply":
    case "stake":
    case "perp_open":
      return m.direction === "out" ? "supply" : "claim";
    case "lp_remove":
    case "lend_withdraw":
    case "unstake":
    case "perp_close":
      return m.direction === "in" ? "withdraw" : "supply";
    case "borrow":
      return m.direction === "in" ? "borrow" : "other";
    case "repay":
      return m.direction === "out" ? "repay" : "other";
    case "claim_rewards":
      return "claim";
    case "transfer_in":
      return "transfer_in";
    case "transfer_out":
      return "transfer_out";
    case "deposit_fiat":
      return "buy"; // из CEX
    case "withdraw_fiat":
      return "sell"; // в CEX
    default:
      return "other";
  }
}

/** Определение «airdrop» vs обычный transfer_in: airdrop = неизвестный отправитель. */
function isAirdrop(op: ClassifiedOp): boolean {
  if (op.type !== "transfer_in" && op.type !== "claim_rewards") return false;
  // Если есть protocol — это claim из протокола, не airdrop
  if (op.protocol) return false;
  // Если counterparty — известный CEX или собственный кошелёк, не airdrop
  // (тут уже classifyOne пометил бы как deposit_fiat/transfer_in пары)
  return true;
}

/**
 * Строит timeline для одного токена.
 *
 * @param symbol Символ токена (нормализованный, например "ETH" не "WETH")
 * @param ops Все ops кошелька
 * @param currentAmount Текущий баланс (для показа в summary)
 */
export function buildAssetTimeline(
  symbol: string,
  ops: ClassifiedOp[],
  currentAmount: number,
): AssetTimelineSummary {
  const target = normSym(symbol);
  const events: AssetTimelineEvent[] = [];

  let totalBought = 0;
  let totalBoughtUsd = 0;
  let totalSold = 0;
  let totalSoldUsd = 0;
  let totalSupplied = 0;
  let totalWithdrawn = 0;

  // Cumulative WAC: amount of buys × price = totalCostBasis
  let cumBoughtAmount = 0;
  let cumBoughtCostUsd = 0;

  for (const op of ops) {
    if (op.status === "failed") continue;
    if (isJunkOp(op)) continue;
    for (const m of op.movement) {
      if (m.amount <= 0) continue;
      if (normSym(m.symbol) !== target) continue;
      const usd = m.usd ?? 0;
      const pricePerUnit = m.amount > 0 ? usd / m.amount : null;
      let kind = eventKind(op, m);
      if (kind === "transfer_in" && isAirdrop(op)) kind = "airdrop";
      events.push({
        time: op.time,
        kind,
        txHash: op.hash,
        chain: op.chain,
        direction: m.direction,
        amount: m.amount,
        usd,
        pricePerUnit,
        counterparty: op.counterparty,
        protocol: op.protocol?.name ?? null,
      });
      // Aggregates
      if (kind === "buy" || kind === "claim" || kind === "airdrop" || kind === "transfer_in") {
        totalBought += m.amount;
        totalBoughtUsd += usd;
        // WAC: airdrops count as $0 cost basis, но amount считается
        if (kind === "airdrop") {
          cumBoughtAmount += m.amount;
          // cost = 0 → WAC уменьшается
        } else if (kind === "buy") {
          cumBoughtAmount += m.amount;
          cumBoughtCostUsd += usd;
        } else if (kind === "claim") {
          // Claims also at $0 (already-earned, no purchase cost)
          cumBoughtAmount += m.amount;
        } else if (kind === "transfer_in") {
          // Transfer без cost basis — будем верить m.usd как proxy
          cumBoughtAmount += m.amount;
          cumBoughtCostUsd += usd;
        }
      } else if (kind === "sell" || kind === "transfer_out") {
        totalSold += m.amount;
        totalSoldUsd += usd;
      } else if (kind === "supply" || kind === "repay") {
        totalSupplied += m.amount;
      } else if (kind === "withdraw" || kind === "borrow") {
        totalWithdrawn += m.amount;
      }
    }
  }

  events.sort((a, b) => b.time - a.time); // newest first

  const weightedAvgPrice =
    cumBoughtAmount > 0 ? cumBoughtCostUsd / cumBoughtAmount : null;

  return {
    symbol: target,
    events,
    totalBought,
    totalBoughtUsd,
    totalSold,
    totalSoldUsd,
    totalSupplied,
    totalWithdrawn,
    currentAmount,
    weightedAvgPrice,
  };
}

/** Локализация kind для UI. */
export function assetEventKindLabel(
  kind: AssetTimelineEvent["kind"],
): string {
  switch (kind) {
    case "buy":
      return "Покупка";
    case "sell":
      return "Продажа";
    case "supply":
      return "Внесение в DeFi";
    case "withdraw":
      return "Вывод из DeFi";
    case "claim":
      return "Получение награды";
    case "airdrop":
      return "Airdrop";
    case "transfer_in":
      return "Перевод (in)";
    case "transfer_out":
      return "Перевод (out)";
    case "borrow":
      return "Заём";
    case "repay":
      return "Погашение";
    default:
      return "Прочее";
  }
}

// Re-export для удобства (UI компонент будет фильтровать stable-токены).
export { isStableSymbol };
