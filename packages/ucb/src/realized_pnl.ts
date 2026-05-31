/**
 * UCB E3: realized PnL aggregator per token family.
 *
 * Definitions:
 *   - **Realized event** = операция, при которой user продал часть position'а
 *     и получил USD-эквивалент (стейбл / fiat). Прибыль/убыток зафиксирован.
 *   - **Unrealized PnL** = current_value − remaining_cost_basis (E1 уже считает).
 *
 * Что считаем реализацией (v1, conservative):
 *   1. `swap`: non-stable OUT → stable IN. Proceeds = stable received USD.
 *   2. `withdraw_fiat`: crypto OUT через P2P/банк. Proceeds = m.usd OUT side.
 *   3. `transfer_out` на CEX: НЕ считаем (это перемещение, не продажа —
 *       CEX cost-basis наследуется).
 *   4. `lp_remove` / `lend_withdraw`: НЕ считаем (это закрытие позиции,
 *       cost basis возвращается в lots).
 *
 * Метод: проходим ops хронологически, держим свой LotTracker (отдельный
 * от основного — чтобы не интерферировать), при detected realization
 * читаем consumed.totalCostUsd из tracker.consume() и сравниваем с
 * proceeds.usd.
 *
 * Не покрывает (backlog v2):
 *   - Token→token swap: WBTC→ETH = realization части WBTC + new ETH lot.
 *     Сейчас просто переносится cost basis без realized number.
 *   - Bridge/transfer fees: разница между out and in amounts не помечается
 *     как realized loss (cost basis уже консумится через handleBridgeOut
 *     в основном tracker'е, но не записывается отдельно как loss).
 *   - CEX-side trades: не имеем on-chain ops для них (только cex_trades).
 */

import { isStableSymbol, tokenFamily } from "./protocols.js";
import { LotTracker } from "./lots/lot_tracker.js";
import type { ClassifiedOp, TokenMovement } from "./types.js";

function isGasMovement(m: TokenMovement): boolean {
  if (m.symbol !== "ETH" && m.symbol !== "WETH") return false;
  return m.amount < 0.01 && (m.usd ?? 0) < 100;
}

export interface RealizedPnlEntry {
  /** Family of asset sold. */
  readonly family: string;
  /** Сумма realized USD по всем sale events этого family. */
  readonly realizedUsd: number;
  /** Сколько sale events (для UI hints). */
  readonly eventCount: number;
}

/**
 * Compute realized PnL per family для одного wallet.
 *
 * Возвращает массив, отсортированный по `Math.abs(realizedUsd)` desc —
 * самые impactful gains/losses первые.
 *
 * `costBasisOverrideByHash` — same map, что в `buildLotsAndPositions`
 * (manual annotation / CEX inheritance / D5 bridge WAC). Гарантирует
 * консистентный cost basis с основным tracker'ом.
 */
export function computeRealizedPnlByFamily(
  ops: readonly ClassifiedOp[],
  walletId: string,
  costBasisOverrideByHash: ReadonlyMap<string, number> = new Map(),
): RealizedPnlEntry[] {
  // Отдельный tracker — мы должны видеть СОСТОЯНИЕ lots на момент каждой
  // sale, а основной tracker уже прошёл вперёд по всем ops.
  const tracker = new LotTracker("WAC");
  const realizedByFamily = new Map<
    string,
    { realizedUsd: number; eventCount: number }
  >();

  const sorted = [...ops].sort((a, b) => a.time - b.time);

  for (const op of sorted) {
    if (op.status === "failed") continue;
    const override = costBasisOverrideByHash.get(op.hash.toLowerCase());

    switch (op.type) {
      case "swap":
        handleSwap(op, tracker, walletId, override, realizedByFamily);
        break;
      case "transfer_in":
      case "deposit_fiat":
        handleTransferIn(op, tracker, walletId, override);
        break;
      case "bridge_in":
        // Тот же путь — для realized PnL bridges это no-op (cost
        // переносится). Создаём lot с derived cost чтобы tracker не
        // потерял asset.
        handleTransferIn(op, tracker, walletId, override);
        break;
      case "transfer_out":
      case "bridge_out":
        handleTransferOut(op, tracker, walletId);
        break;
      case "withdraw_fiat":
        handleWithdrawFiat(op, tracker, walletId, realizedByFamily);
        break;
      case "claim_rewards":
        // UCB D6: rewards acquire at cost=0 → если позже продаются
        // за стейбл, full proceeds = realized gain.
        handleReward(op, tracker, walletId);
        break;
      // lend_supply / lend_withdraw / borrow / repay — пропускаем, эти
      // не realization events. Положения обрабатываются в основном
      // pipeline через emitPositionEvent.
    }
  }

  const result: RealizedPnlEntry[] = [];
  for (const [family, data] of realizedByFamily) {
    result.push({
      family,
      realizedUsd: data.realizedUsd,
      eventCount: data.eventCount,
    });
  }
  result.sort((a, b) => Math.abs(b.realizedUsd) - Math.abs(a.realizedUsd));
  return result;
}

function handleReward(
  op: ClassifiedOp,
  tracker: LotTracker,
  walletId: string,
): void {
  // UCB D6: reward acquisition имеет cost basis = $0. Sale later
  // даст realized = full proceeds. FMV в реализованном PnL агрегаторе
  // не нужен (он для income reporting).
  for (const m of op.movement) {
    if (m.direction !== "in" || m.amount <= 0) continue;
    const fmv = isStableSymbol(m.symbol) ? m.amount : (m.usd ?? 0);
    tracker.acquire({
      symbol: m.symbol,
      tokenId: m.tokenId,
      chain: op.chain,
      amount: m.amount,
      costPerUnitUsd: 0,
      acquiredAt: op.time,
      acquiredVia: "received_as_reward",
      sourceHash: op.hash,
      walletId,
      fmvAtAcquisitionUsd: fmv,
    });
  }
}

function handleTransferIn(
  op: ClassifiedOp,
  tracker: LotTracker,
  walletId: string,
  overrideUsd: number | undefined,
): void {
  const ins = op.movement.filter((m) => m.direction === "in" && m.amount > 0);
  const totalAmount = ins.reduce((s, m) => s + m.amount, 0);
  for (const m of ins) {
    let usd: number;
    if (
      overrideUsd != null &&
      Number.isFinite(overrideUsd) &&
      overrideUsd >= 0 &&
      totalAmount > 0
    ) {
      usd = overrideUsd * (m.amount / totalAmount);
    } else if (isStableSymbol(m.symbol)) {
      usd = m.amount;
    } else {
      usd = m.usd ?? 0;
    }
    tracker.acquire({
      symbol: m.symbol,
      tokenId: m.tokenId,
      chain: op.chain,
      amount: m.amount,
      costPerUnitUsd: m.amount > 0 ? usd / m.amount : 0,
      acquiredAt: op.time,
      acquiredVia: "transfer_in",
      sourceHash: op.hash,
      walletId,
    });
  }
}

function handleTransferOut(
  op: ClassifiedOp,
  tracker: LotTracker,
  walletId: string,
): void {
  for (const m of op.movement) {
    if (m.direction !== "out" || m.amount <= 0) continue;
    if (isGasMovement(m)) continue;
    tracker.consume({
      symbol: m.symbol,
      tokenId: m.tokenId,
      chain: op.chain,
      amount: m.amount,
      consumedAt: op.time,
      walletId,
    });
  }
}

function handleWithdrawFiat(
  op: ClassifiedOp,
  tracker: LotTracker,
  walletId: string,
  realizedByFamily: Map<
    string,
    { realizedUsd: number; eventCount: number }
  >,
): void {
  for (const m of op.movement) {
    if (m.direction !== "out" || m.amount <= 0) continue;
    if (isGasMovement(m)) continue;
    const proceedsUsd = m.usd ?? 0;
    const consumed = tracker.consume({
      symbol: m.symbol,
      tokenId: m.tokenId,
      chain: op.chain,
      amount: m.amount,
      consumedAt: op.time,
      walletId,
    });
    if (consumed.totalCostUsd > 0 || proceedsUsd > 0) {
      addRealized(
        realizedByFamily,
        tokenFamily(m.symbol),
        proceedsUsd - consumed.totalCostUsd,
      );
    }
  }
}

function handleSwap(
  op: ClassifiedOp,
  tracker: LotTracker,
  walletId: string,
  overrideUsd: number | undefined,
  realizedByFamily: Map<
    string,
    { realizedUsd: number; eventCount: number }
  >,
): void {
  const ins = op.movement.filter((m) => m.direction === "in" && m.amount > 0);
  const outs = op.movement.filter(
    (m) => m.direction === "out" && m.amount > 0 && !isGasMovement(m),
  );
  if (ins.length === 0 || outs.length === 0) return;

  const stableInsTotalUsd = ins
    .filter((m) => isStableSymbol(m.symbol))
    .reduce((s, m) => s + m.amount, 0);
  const totalProceedsForOut = stableInsTotalUsd;

  // Consume out side, compute paid USD.
  let paidUsd = 0;
  for (const m of outs) {
    const consumed = tracker.consume({
      symbol: m.symbol,
      tokenId: m.tokenId,
      chain: op.chain,
      amount: m.amount,
      consumedAt: op.time,
      walletId,
    });
    if (consumed.totalCostUsd > 0) {
      paidUsd += consumed.totalCostUsd;
    } else if (isStableSymbol(m.symbol)) {
      paidUsd += m.amount;
    } else {
      paidUsd += m.usd ?? 0;
    }
    // Realize gain ТОЛЬКО для non-stable out (продали non-stable за стейбл).
    // Stable→Stable / Stable→Non-stable: cost basis carries, не realize.
    //
    // UCB D6: убрали `consumed.totalCostUsd > 0` guard — reward лоты
    // имеют cost=0, но их продажа = full proceeds как realized gain.
    if (!isStableSymbol(m.symbol) && totalProceedsForOut > 0) {
      // Pro-rata по amount если outs > 1, иначе вся proceeds на этот m.
      const outAmtTotal = outs.reduce((s, x) => s + x.amount, 0);
      const share = outAmtTotal > 0 ? m.amount / outAmtTotal : 1;
      const proceeds = totalProceedsForOut * share;
      addRealized(
        realizedByFamily,
        tokenFamily(m.symbol),
        proceeds - consumed.totalCostUsd,
      );
    }
  }

  // Acquire in side с cost = paidUsd pro-rata. Override (если есть)
  // заменяет paidUsd.
  if (
    overrideUsd != null &&
    Number.isFinite(overrideUsd) &&
    overrideUsd >= 0
  ) {
    paidUsd = overrideUsd;
  }
  const totalInAmount = ins.reduce((s, m) => s + m.amount, 0);
  for (const m of ins) {
    const share = totalInAmount > 0 ? m.amount / totalInAmount : 1 / ins.length;
    const cost = paidUsd * share;
    tracker.acquire({
      symbol: m.symbol,
      tokenId: m.tokenId,
      chain: op.chain,
      amount: m.amount,
      costPerUnitUsd: m.amount > 0 ? cost / m.amount : 0,
      acquiredAt: op.time,
      acquiredVia: "swap",
      sourceHash: op.hash,
      walletId,
    });
  }
}

/**
 * UCB D6: суммарный «доход от наград» per family.
 *
 * Reward = FMV (fair-market value) на момент получения. Это **не**
 * realized gain (gain фиксируется при sale награды за stable). Это
 * **income** — сумма стоимости полученных наград, которая нужна для:
 *   - tax reporting (US: ordinary income at FMV at receipt)
 *   - аналитики «сколько APY я реально получил»
 *
 * Вход — те же ops, что в `computeRealizedPnlByFamily`. Не зависит от
 * lot-tracker'а: просто сумма m.usd для in-side от claim_rewards.
 */
export interface RewardIncomeEntry {
  readonly family: string;
  readonly fmvUsd: number;
  readonly eventCount: number;
}

export function computeRewardIncomeByFamily(
  ops: readonly ClassifiedOp[],
): RewardIncomeEntry[] {
  const byFamily = new Map<string, { fmvUsd: number; eventCount: number }>();
  for (const op of ops) {
    if (op.type !== "claim_rewards") continue;
    if (op.status === "failed") continue;
    let touched = false;
    for (const m of op.movement) {
      if (m.direction !== "in" || m.amount <= 0) continue;
      const fmv = isStableSymbol(m.symbol) ? m.amount : (m.usd ?? 0);
      if (fmv <= 0) continue;
      const family = tokenFamily(m.symbol);
      if (!family) continue;
      const cur = byFamily.get(family) ?? { fmvUsd: 0, eventCount: 0 };
      cur.fmvUsd += fmv;
      if (!touched) {
        cur.eventCount += 1;
        touched = true;
      }
      byFamily.set(family, cur);
    }
  }
  const result: RewardIncomeEntry[] = [];
  for (const [family, data] of byFamily) {
    result.push({
      family,
      fmvUsd: data.fmvUsd,
      eventCount: data.eventCount,
    });
  }
  result.sort((a, b) => b.fmvUsd - a.fmvUsd);
  return result;
}

function addRealized(
  map: Map<string, { realizedUsd: number; eventCount: number }>,
  family: string,
  delta: number,
): void {
  if (!family || !Number.isFinite(delta)) return;
  const cur = map.get(family) ?? { realizedUsd: 0, eventCount: 0 };
  cur.realizedUsd += delta;
  cur.eventCount += 1;
  map.set(family, cur);
}
