/**
 * Tax T1: per-lot tax events generator.
 *
 * Walk ops chronologically, для каждой disposition (sale | exchange) →
 * consume lots → emit TaxEvent per LotConsumption (per-lot detail).
 *
 * Disposition definitions (US-default; per-jurisdiction варианты — T3+ backlog):
 *   - **sale**: non-stable → stable swap или withdraw_fiat. Plain capital gain.
 *   - **exchange**: token-to-token swap (e.g. ETH→BTC). С 2018 в US это taxable
 *     event (нет "like-kind" exception для crypto).
 *   - **income**: reward acquisition (D6). FMV at receipt = ordinary income.
 *     Cost basis = 0 → последующая продажа = full proceeds gain.
 *
 * NOT a disposition (no event):
 *   - transfer_in / transfer_out / bridge_* (move between own wallets)
 *   - lend_supply / lend_withdraw / lp_add / lp_remove / stake / unstake
 *     (open/close protocol position — handled через built-in lot consume,
 *     no realization до final sale)
 *   - borrow / repay (debt operations, не disposition)
 *
 * Output Sorted by `disposedAt` asc для предсказуемого ordering в reports.
 */
import { isStableSymbol, tokenFamily } from "./protocols";
import { LotTracker } from "./lots/lot_tracker";
import type { LotMethodology } from "./lots/types";
import {
  getJurisdictionConfig,
  type Jurisdiction,
} from "./tax_jurisdictions";
import type { ClassifiedOp, TokenMovement } from "./types";

const DAY_SEC = 24 * 60 * 60;

function isGasMovement(m: TokenMovement): boolean {
  if (m.symbol !== "ETH" && m.symbol !== "WETH") return false;
  return m.amount < 0.01 && (m.usd ?? 0) < 100;
}

export type TaxEventType = "sale" | "exchange" | "income";
export type TaxTerm = "short" | "long";

export interface TaxEvent {
  /** Disposition timestamp (unix sec). */
  readonly disposedAt: number;
  /** Когда был acquired лот (unix sec). */
  readonly acquiredAt: number;
  /** Days между acquired and disposed. */
  readonly holdingPeriodDays: number;
  readonly term: TaxTerm;
  readonly eventType: TaxEventType;
  /** Token symbol (нормализованный family для US-reports). */
  readonly asset: string;
  readonly assetFamily: string;
  /** Amount disposed (in token units). */
  readonly amount: number;
  /** USD proceeds. */
  readonly proceedsUsd: number;
  /** USD cost basis. */
  readonly costBasisUsd: number;
  /** proceeds - cost. Negative = loss. */
  readonly gainUsd: number;
  /** Disposition tx hash. */
  readonly txHash: string;
  /** Chain identifier. */
  readonly chain: string;
  /** Source acquisition tx hash (for audit trail). */
  readonly sourceHash: string;
  /** Wallet ID. */
  readonly walletId: string;
}

/**
 * Walk ops, generate per-lot tax events.
 *
 * T1.1: `method` опционален — WAC (default), FIFO, LIFO, HIFO. Управляет
 * consume order при disposition. HIFO = tax-optimal (минимизирует gain).
 *
 * T5: `jurisdiction` опционален (default US) — управляет long-term threshold
 * и tokenToTokenTaxable. См. `tax_jurisdictions.ts` для config'ов.
 */
export function generateTaxEvents(
  ops: readonly ClassifiedOp[],
  walletId: string,
  method: LotMethodology = "WAC",
  jurisdiction: Jurisdiction = "US",
): TaxEvent[] {
  const sorted = [...ops]
    .filter((o) => o.status !== "failed")
    .sort((a, b) => a.time - b.time);
  if (sorted.length === 0) return [];

  const config = getJurisdictionConfig(jurisdiction);
  const tracker = new LotTracker(method);
  const events: TaxEvent[] = [];

  for (const op of sorted) {
    switch (op.type) {
      case "swap":
        handleSwap(op, tracker, walletId, events, config);
        break;
      case "withdraw_fiat":
        handleWithdrawFiat(op, tracker, walletId, events, config);
        break;
      case "claim_rewards":
        handleReward(op, tracker, walletId, events, config);
        break;
      case "transfer_in":
      case "deposit_fiat":
      case "bridge_in":
        handleAcquisition(op, tracker, walletId, "transfer_in");
        break;
      case "transfer_out":
      case "bridge_out":
        handleNonTaxableOut(op, tracker, walletId);
        break;
    }
  }

  return events.sort((a, b) => a.disposedAt - b.disposedAt);
}

// ─── handlers ─────────────────────────────────────────────────────────

function handleAcquisition(
  op: ClassifiedOp,
  tracker: LotTracker,
  walletId: string,
  via: "transfer_in" | "received_as_reward",
): void {
  for (const m of op.movement) {
    if (m.direction !== "in" || m.amount <= 0) continue;
    if (isGasMovement(m)) continue;
    const usd = isStableSymbol(m.symbol) ? m.amount : (m.usd ?? 0);
    tracker.acquire({
      symbol: m.symbol,
      tokenId: m.tokenId,
      chain: op.chain,
      amount: m.amount,
      costPerUnitUsd:
        via === "received_as_reward" ? 0 : m.amount > 0 ? usd / m.amount : 0,
      acquiredAt: op.time,
      acquiredVia: via,
      sourceHash: op.hash,
      walletId,
      ...(via === "received_as_reward" && {
        fmvAtAcquisitionUsd: usd,
      }),
    });
  }
}

function handleNonTaxableOut(
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

function handleReward(
  op: ClassifiedOp,
  tracker: LotTracker,
  walletId: string,
  events: TaxEvent[],
  _config: import("./tax_jurisdictions").JurisdictionConfig,
): void {
  for (const m of op.movement) {
    if (m.direction !== "in" || m.amount <= 0) continue;
    const fmv = isStableSymbol(m.symbol) ? m.amount : (m.usd ?? 0);
    if (fmv > 0) {
      events.push({
        disposedAt: op.time,
        acquiredAt: op.time,
        holdingPeriodDays: 0,
        term: "short", // income всегда short-term (ordinary income в US).
        eventType: "income",
        asset: m.symbol.toUpperCase(),
        assetFamily: tokenFamily(m.symbol),
        amount: m.amount,
        proceedsUsd: fmv,
        costBasisUsd: 0,
        gainUsd: fmv,
        txHash: op.hash,
        chain: op.chain,
        sourceHash: op.hash,
        walletId,
      });
    }
    handleAcquisition(op, tracker, walletId, "received_as_reward");
  }
}

function handleWithdrawFiat(
  op: ClassifiedOp,
  tracker: LotTracker,
  walletId: string,
  events: TaxEvent[],
  config: import("./tax_jurisdictions").JurisdictionConfig,
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
    emitFromConsumption(
      consumed,
      m,
      op,
      walletId,
      proceedsUsd,
      "sale",
      events,
      config,
    );
  }
}

function handleSwap(
  op: ClassifiedOp,
  tracker: LotTracker,
  walletId: string,
  events: TaxEvent[],
  config: import("./tax_jurisdictions").JurisdictionConfig,
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

  // Sum cost basis paid (from out-side consume) для acquisition stage.
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

    // Emit tax event ТОЛЬКО для non-stable out (продали актив):
    //  - если получили stable → 'sale'
    //  - если получили non-stable → 'exchange' (US: token-to-token taxable)
    if (isStableSymbol(m.symbol)) continue; // stable→anything не реализация

    const outAmtTotal = outs.reduce((s, x) => s + x.amount, 0);
    const share = outAmtTotal > 0 ? m.amount / outAmtTotal : 1;
    const eventType: TaxEventType =
      totalProceedsForOut > 0 ? "sale" : "exchange";
    // T5: пропускаем 'exchange' если jurisdiction не считает token-to-token
    // taxable (like-kind exception). 'sale' (proceeds → stable) всегда emit'ится.
    if (eventType === "exchange" && !config.tokenToTokenTaxable) {
      continue;
    }
    const proceedsUsd =
      eventType === "sale" ? totalProceedsForOut * share : (m.usd ?? 0);
    emitFromConsumption(
      consumed,
      m,
      op,
      walletId,
      proceedsUsd,
      eventType,
      events,
      config,
    );
  }

  // Acquire in-side с paid cost (это устанавливает cost basis для
  // дальнейших lots; не emit event).
  const totalInAmount = ins.reduce((s, x) => s + x.amount, 0);
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
      acquiredVia: isStableSymbol(m.symbol) ? "swap" : "buy_with_stable",
      sourceHash: op.hash,
      walletId,
    });
  }
}

function emitFromConsumption(
  consumed: ReturnType<LotTracker["consume"]>,
  movement: TokenMovement,
  op: ClassifiedOp,
  walletId: string,
  proceedsUsd: number,
  eventType: TaxEventType,
  events: TaxEvent[],
  config: import("./tax_jurisdictions").JurisdictionConfig,
): void {
  if (consumed.consumed.length === 0) {
    events.push(makeEvent({
      disposedAt: op.time,
      acquiredAt: op.time,
      amount: movement.amount,
      proceedsUsd,
      costBasisUsd: 0,
      asset: movement.symbol,
      txHash: op.hash,
      chain: op.chain,
      sourceHash: op.hash,
      walletId,
      eventType,
      longTermThresholdDays: config.longTermThresholdDays,
    }));
    return;
  }
  const totalAmount = consumed.totalAmount;
  for (const c of consumed.consumed) {
    const share = totalAmount > 0 ? c.amountConsumed / totalAmount : 1;
    events.push(
      makeEvent({
        disposedAt: op.time,
        acquiredAt: c.lot.acquiredAt,
        amount: c.amountConsumed,
        proceedsUsd: proceedsUsd * share,
        costBasisUsd: c.costAttributedUsd,
        asset: movement.symbol,
        txHash: op.hash,
        chain: op.chain,
        sourceHash: c.lot.sourceHash,
        walletId,
        eventType,
        longTermThresholdDays: config.longTermThresholdDays,
      }),
    );
  }
}

function makeEvent(input: {
  disposedAt: number;
  acquiredAt: number;
  amount: number;
  proceedsUsd: number;
  costBasisUsd: number;
  asset: string;
  txHash: string;
  chain: string;
  sourceHash: string;
  walletId: string;
  eventType: TaxEventType;
  longTermThresholdDays: number;
}): TaxEvent {
  const days = Math.floor((input.disposedAt - input.acquiredAt) / DAY_SEC);
  return {
    disposedAt: input.disposedAt,
    acquiredAt: input.acquiredAt,
    holdingPeriodDays: days,
    term: days >= input.longTermThresholdDays ? "long" : "short",
    eventType: input.eventType,
    asset: input.asset.toUpperCase(),
    assetFamily: tokenFamily(input.asset),
    amount: input.amount,
    proceedsUsd: input.proceedsUsd,
    costBasisUsd: input.costBasisUsd,
    gainUsd: input.proceedsUsd - input.costBasisUsd,
    txHash: input.txHash,
    chain: input.chain,
    sourceHash: input.sourceHash,
    walletId: input.walletId,
  };
}
