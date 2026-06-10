/**
 * Cross-protocol lot transfer.
 *
 * Когда токен который у пользователя как lot (с известным cost basis)
 * уходит в DEPOSIT_COLLATERAL events в Position (Aave, Morpho, …),
 * cost basis должен **переехать** в эту позицию. Тогда close позиции
 * будет давать realistic PnL.
 *
 * Пример: GMX V2 даёт пользователю GLV (lot создан с cost basis $1.534/GLV
 * через handleSupply в build.ts). Затем GLV отдаётся в Morpho как
 * collateral → Position event `deposit_collateral` с lotConsumption,
 * указывающим какие лоты GLV ушли в эту позицию.
 *
 * Этот модуль — combiner: проходит ops + LotTracker + PositionTracker
 * вместе, эмитит cross-protocol-aware events.
 *
 * **Главный wiring** для Этапа 12 / Фазы 5: `buildEverything(ops, walletId)`
 * возвращает (LotTracker, PositionTracker) согласованно прокачанные
 * через единственный chronological pass.
 */

import {
  defillamaCoinKey,
  priceFromMap,
  priceFromMapNearest,
} from "../pricing.js";
import { isJunkOp } from "../junk_filter.js";
import { isStableSymbol } from "../protocols.js";
import { isReceiptLessProtocol, isReceiptOfProtocol } from "../token_roles.js";
import { LotTracker } from "../lots/lot_tracker.js";
import type { AcquiredVia } from "../lots/types.js";
import type { ClassifiedOp, TokenMovement } from "../types.js";
import { PositionTracker } from "./position_tracker.js";
import type { PositionEvent, PositionEventType } from "./types.js";

interface BuildResult {
  lots: LotTracker;
  positions: PositionTracker;
}

interface BuildOptions {
  histPrices?: Map<string, number>;
  walletNameById: Map<string, string>;
  /**
   * UCB A4.2: per-op cost basis overrides — keyed by `op.hash.toLowerCase()`.
   * Override = TOTAL USD spent на acquisition этой tx (не per-unit).
   * Применяется в handleSwap (заменяет paidUsd) и handleTransferIn
   * (заменяет derived `tokenUsdHist`).
   *
   * Источник: server annotation `manual_cost_basis_usd` (A3 + A4 wiring
   * в `LoadedWalletsProvider`).
   */
  costBasisOverrideByHash?: Map<string, number>;
}

function isGas(m: TokenMovement): boolean {
  if (m.symbol !== "ETH" && m.symbol !== "WETH") return false;
  return m.amount < 0.01 && (m.usd ?? 0) < 100;
}

function tokenUsdHist(
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
    // UCB D9: sparse hist-data fallback — ближайший bucket в ±7d окне.
    // Не идеально для time-sensitive metrics, но даёт approximate cost
    // basis для редких токенов где иначе была бы 0.
    const nearest = priceFromMapNearest(histPrices, coin, time);
    if (nearest != null && nearest.price > 0) return m.amount * nearest.price;
  }
  if (m.usd != null && m.usd > 0) return m.usd;
  return 0;
}

function stripChainPrefix(id: string): string {
  return id
    .replace(/^[a-z]{2,6}:/i, "")
    .replace(/:[a-z][a-z0-9_-]+$/i, "")
    .toLowerCase();
}

/**
 * Главный builder — запускает ops через LotTracker И PositionTracker
 * в один chronological pass. Cost basis для cross-protocol depositов
 * берётся из текущего LotTracker (т.е. учитывает предыдущие приобретения
 * того же токена в других протоколах).
 *
 * После этого:
 *   - Lots содержат полную картину покупок/продаж/начислений
 *   - Positions содержат events с reference на consumed lots
 *   - Запросы UI становятся быстрыми и derived
 */
export function buildLotsAndPositions(
  ops: ClassifiedOp[],
  walletId: string,
  options: BuildOptions,
): BuildResult {
  const lots = new LotTracker("WAC");
  const positions = new PositionTracker();
  const histPrices = options.histPrices ?? new Map<string, number>();
  const overrides =
    options.costBasisOverrideByHash ?? new Map<string, number>();
  const walletName = options.walletNameById.get(walletId) ?? walletId;

  // UCB D5: per-symbol-family last bridge_out WAC, для передачи cost
  // basis в matching bridge_in (та же chain-agnostic family key).
  const lastBridgeOutWac = new Map<string, number>();

  // UCB C10: self-loop collateral state — отслеживает consumed cost
  // basis WBTC/ETH/etc. при supply в lending protocol. Если потом
  // тот же asset borrow'ится из ТОГО ЖЕ protocol (leverage loop),
  // borrow inherits cost pro-rata. Иначе borrow = $0 (strict UCB).
  //
  // Канарейка: artur@gmail.com POS-005 — Morpho supply $20k WBTC →
  // Morpho borrow 0.226 WBTC → Fluid supply. До C10 в cross_protocol
  // borrow создавал lot с cost=0 → Fluid supply видел пустой пул →
  // walker fallback на m.usd $17,280 (не $20k реальных трат).
  // Key: `walletId|protocolId|symbol`. Value: { amount, totalCost }.
  const selfLoopCollateral = new Map<
    string,
    { amount: number; totalCost: number }
  >();

  // Owner-методика 2026-06-10 (testakk GMX rebalance): async-withdraw пары
  // (GMX V2 multicall-burn → executeWithdrawal-legs, разные tx). Tx A
  // списывает receipt-лоты (их стоимость = attributedCost), но ноги приходят
  // в Tx B. Раньше стоимость ВЫБРАСЫВАЛАСЬ → ноги получали лоты cost=0 →
  // Fluid supply падал на market-fallback (терялся унаследованный PnL GM).
  // Здесь: Tx A складывает списанную стоимость по своему hash; Tx B забирает
  // её через op.linkedHash (выставлен async_deposit_linker'ом).
  const pendingWithdrawCost = new Map<string, number>();

  const sorted = [...ops].sort((a, b) => a.time - b.time);

  for (const op of sorted) {
    if (op.status === "failed") continue;
    if (isJunkOp(op)) continue;

    // D5: capture WAC ПЕРЕД consume в handleLotsForOp.
    if (op.type === "bridge_out") {
      for (const m of op.movement) {
        if (m.direction !== "out" || m.amount <= 0) continue;
        const wac = lots.wacAt(walletId, m.symbol, op.time);
        if (wac != null && wac > 0) {
          lastBridgeOutWac.set(m.symbol.toUpperCase(), wac);
        }
      }
    }

    // 1. Обновляем lots для swap / transfer / claim / approve.
    handleLotsForOp(op, lots, walletId, histPrices, overrides, lastBridgeOutWac);

    // 2. Если это позиционная op — эмитим event в PositionTracker.
    if (op.protocol) {
      const eventType = mapOpToEventType(op.type);
      if (!eventType) continue;
      const marketKey = inferMarketKey(op, walletId);
      if (!marketKey) continue;
      emitPositionEvent(
        op,
        eventType,
        marketKey,
        walletId,
        walletName,
        positions,
        lots,
        histPrices,
        selfLoopCollateral,
        pendingWithdrawCost,
      );
    }
  }

  return { lots, positions };
}

// ─── Lots side ──────────────────────────────────────────────────────────

function handleLotsForOp(
  op: ClassifiedOp,
  lots: LotTracker,
  walletId: string,
  histPrices: Map<string, number>,
  overrides: Map<string, number>,
  lastBridgeOutWac: Map<string, number>,
): void {
  // Эта функция отвечает за UPDATE lots для НЕ-позиционных ops (swap,
  // transfer_in/out, deposit_fiat, claim_rewards). Для позиционных
  // (lp_add/remove, lend_supply/withdraw, borrow/repay) lot-attribution
  // делается внутри `emitPositionEvent` вместе с position-event.
  const override = overrides.get(op.hash.toLowerCase());
  switch (op.type) {
    case "swap":
      handleSwap(op, lots, walletId, histPrices, override);
      break;
    case "transfer_in":
    case "deposit_fiat":
      handleTransferIn(op, lots, walletId, histPrices, override);
      break;
    case "bridge_in":
      // UCB D5: bridge_in — другая семантика чем transfer_in. Cost basis
      // должен сохраняться через chains (asset не покинул user'а, просто
      // changed network). Precedence: override → lastBridgeOutWac →
      // existing WAC → derived market.
      handleBridgeIn(
        op,
        lots,
        walletId,
        histPrices,
        override,
        lastBridgeOutWac,
      );
      break;
    case "transfer_out":
    case "withdraw_fiat":
    case "bridge_out":
      handleTransferOut(op, lots, walletId);
      break;
    case "claim_rewards":
      handleClaim(op, lots, walletId, histPrices);
      break;
  }
}

function handleSwap(
  op: ClassifiedOp,
  lots: LotTracker,
  walletId: string,
  histPrices: Map<string, number>,
  overrideUsd?: number,
): void {
  const ins = op.movement.filter((m) => m.direction === "in" && m.amount > 0);
  const outs = op.movement.filter(
    (m) => m.direction === "out" && m.amount > 0 && !isGas(m),
  );
  if (ins.length === 0 || outs.length === 0) return;

  let paidUsd = 0;
  for (const m of outs) {
    const consumed = lots.consume({
      symbol: m.symbol,
      tokenId: m.tokenId,
      chain: op.chain,
      amount: m.amount,
      consumedAt: op.time,
      walletId,
    });
    // Owner-методика 2026-06-10: «доллар = доллар» — стейбл-оплата ВСЕГДА
    // по номиналу, независимо от стоимости потреблённых стейбл-лотов.
    // Раньше consumed.totalCostUsd стейблов (среди них cost-0 лоты от
    // borrow/rewards) давал фантомную «скидку»: testakk Artur 14.03 покупка
    // WBTC за 10 000 USDC получала лот $1 901 (lots.consume оставляем —
    // баланс стейблов вести нужно, но цена расхода = номинал).
    if (isStableSymbol(m.symbol)) {
      paidUsd += m.amount;
    } else if (consumed.totalCostUsd > 0) {
      paidUsd += consumed.totalCostUsd;
    } else {
      paidUsd += tokenUsdHist(m, op.chain, op.time, histPrices);
    }
  }

  // UCB A4.2: explicit override — заменяет derived paidUsd.
  if (
    overrideUsd != null &&
    Number.isFinite(overrideUsd) &&
    overrideUsd >= 0
  ) {
    paidUsd = overrideUsd;
  }

  const totalInUsd = ins.reduce(
    (s, m) => s + tokenUsdHist(m, op.chain, op.time, histPrices),
    0,
  );
  const stableOuts = outs.every((m) => m.isStable);
  for (const m of ins) {
    const share =
      totalInUsd > 0
        ? tokenUsdHist(m, op.chain, op.time, histPrices) / totalInUsd
        : 1 / ins.length;
    const costForLot = paidUsd * share;
    lots.acquire({
      symbol: m.symbol,
      tokenId: m.tokenId,
      chain: op.chain,
      amount: m.amount,
      costPerUnitUsd: costForLot / m.amount,
      acquiredAt: op.time,
      acquiredVia: stableOuts
        ? ("buy_with_stable" as AcquiredVia)
        : ("swap" as AcquiredVia),
      sourceHash: op.hash,
      walletId,
    });
  }
}

function handleTransferIn(
  op: ClassifiedOp,
  lots: LotTracker,
  walletId: string,
  histPrices: Map<string, number>,
  overrideUsd?: number,
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
      // UCB A4.2: explicit override делится пропорционально по amount.
      usd = overrideUsd * (m.amount / totalAmount);
    } else {
      usd = isStableSymbol(m.symbol)
        ? m.amount
        : tokenUsdHist(m, op.chain, op.time, histPrices);
    }
    lots.acquire({
      symbol: m.symbol,
      tokenId: m.tokenId,
      chain: op.chain,
      amount: m.amount,
      costPerUnitUsd: m.amount > 0 ? usd / m.amount : 0,
      acquiredAt: op.time,
      acquiredVia:
        op.type === "deposit_fiat"
          ? ("manual_seed" as AcquiredVia)
          : ("transfer_in" as AcquiredVia),
      sourceHash: op.hash,
      walletId,
    });
  }
}

/**
 * UCB D5: bridge_in cost basis inheritance.
 *
 * Семантика bridge_in принципиально отличается от transfer_in:
 *   - transfer_in: asset пришёл от внешнего отправителя (airdrop, salary,
 *     CEX deposit). Cost basis = derived market price (или CEX inheritance
 *     через override map).
 *   - bridge_in: asset МОЙ ЖЕ, просто на другой chain. Cost basis сохранён
 *     с предыдущей chain — должен наследоваться, не пересчитываться по
 *     market price.
 *
 * Precedence (higher takes over):
 *   1. Manual override (`overrideUsd` из A4 annotation)
 *   2. Existing WAC того же (walletId, family) — D5 core
 *   3. CEX cost basis inheritance (`overrideUsd` из server, D3)
 *   4. Fallback: derived market price (legacy behavior)
 *
 * Note: lots in `LotTracker` keyed by `(walletId, family)` — chain-agnostic
 * by design. После bridge_out на eth (consume) → bridge_in на arb (acquire),
 * оба touch'ат тот же ключ `lex2|USDT`. WAC из существующих lots отражает
 * cost basis до bridge'а — мы переиспользуем эту WAC для new lot.
 *
 * Fee bridge: разница (bridge_out_amount − bridge_in_amount) уже списана
 * через consume в `handleTransferOut`; новый lot получает только пришедшее
 * количество с той же WAC. PnL impact фен'а = (out_amount − in_amount) ×
 * WAC, что и нужно.
 */
function handleBridgeIn(
  op: ClassifiedOp,
  lots: LotTracker,
  walletId: string,
  histPrices: Map<string, number>,
  overrideUsd?: number,
  lastBridgeOutWac?: Map<string, number>,
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
    } else {
      const symKey = m.symbol.toUpperCase();
      const wacFromBridge = lastBridgeOutWac?.get(symKey);
      if (wacFromBridge != null && wacFromBridge > 0) {
        usd = m.amount * wacFromBridge;
        lastBridgeOutWac?.delete(symKey);
      } else {
        const existingWac = lots.wacAt(walletId, m.symbol, op.time);
        if (existingWac != null && existingWac > 0) {
          usd = m.amount * existingWac;
        } else {
          usd = isStableSymbol(m.symbol)
            ? m.amount
            : tokenUsdHist(m, op.chain, op.time, histPrices);
        }
      }
    }
    lots.acquire({
      symbol: m.symbol,
      tokenId: m.tokenId,
      chain: op.chain,
      amount: m.amount,
      costPerUnitUsd: m.amount > 0 ? usd / m.amount : 0,
      acquiredAt: op.time,
      acquiredVia: "bridge_in" as AcquiredVia,
      sourceHash: op.hash,
      walletId,
    });
  }
}

function handleTransferOut(
  op: ClassifiedOp,
  lots: LotTracker,
  walletId: string,
): void {
  for (const m of op.movement) {
    if (m.direction !== "out" || m.amount <= 0) continue;
    if (isGas(m)) continue;
    lots.consume({
      symbol: m.symbol,
      tokenId: m.tokenId,
      chain: op.chain,
      amount: m.amount,
      consumedAt: op.time,
      walletId,
    });
  }
}

function handleClaim(
  op: ClassifiedOp,
  lots: LotTracker,
  walletId: string,
  histPrices: Map<string, number>,
): void {
  // UCB D6 (РЕВИЗИЯ owner 2026-06-10, testakk Artur trace): rewards входят в
  // пул ПО РЫНОЧНОЙ ЦЕНЕ на момент клейма — это зафиксированный доход
  // («получил актив стоимостью $X»). Прежнее правило cost=$0 занижало WAC
  // и завышало будущий PnL (Artur: клейм 4.98 ETH 31.01 — почти половина
  // ETH-пула). FMV при получении = и есть cost basis; отдельное поле
  // fmvAtAcquisitionUsd сохраняем для income reporting.
  for (const m of op.movement) {
    if (m.direction !== "in" || m.amount <= 0) continue;
    const fmvUsd = isStableSymbol(m.symbol)
      ? m.amount
      : tokenUsdHist(m, op.chain, op.time, histPrices);
    lots.acquire({
      symbol: m.symbol,
      tokenId: m.tokenId,
      chain: op.chain,
      amount: m.amount,
      costPerUnitUsd: m.amount > 0 ? fmvUsd / m.amount : 0,
      acquiredAt: op.time,
      acquiredVia: "received_as_reward",
      sourceHash: op.hash,
      walletId,
      fmvAtAcquisitionUsd: fmvUsd,
    });
  }
}

// ─── Position-event side ────────────────────────────────────────────────

function inferMarketKey(op: ClassifiedOp, walletId: string): string | null {
  const protoId = op.protocol?.id ?? "";
  if (op.linkedLpTokenId) return stripChainPrefix(op.linkedLpTokenId);
  for (const m of op.movement) {
    if (isReceiptOfProtocol(m.symbol, protoId, m.tokenId)) {
      return stripChainPrefix(m.tokenId);
    }
  }
  // UCB C5 Phase 3 v2 (Task #18, 2026-05-23): для supply-style ops
  // (lp_add/lend_supply/stake/repay/borrow/withdraw/claim_rewards) — если
  // НЕ нашли receipt token в movement, fallback на synthetic key из
  // underlying asset. Раньше это применялось только к receipt-less
  // protocols (Morpho Blue), но legacy `build.ts:handleSupply` всегда
  // consume'ил лоты при lp_add/lend_supply, независимо от receipt-presence.
  // Без расширения cross_protocol skip'ал такие ops → no consume → Σ
  // supplyTokens != actual cost basis в позициях с incomplete chain-ops
  // history (e.g. Aave supply без обнаруженного aETH mint в movement из-за
  // classifier bug). Расширяем для всех position-style ops.
  const isPositionStyleOp =
    op.type === "lp_add" ||
    op.type === "lend_supply" ||
    op.type === "stake" ||
    op.type === "repay" ||
    op.type === "borrow" ||
    op.type === "lp_remove" ||
    op.type === "lend_withdraw" ||
    op.type === "unstake" ||
    op.type === "claim_rewards";
  if (isReceiptLessProtocol(protoId) || isPositionStyleOp) {
    // OUT-side underlying — для supply/repay/lp_add типов где user отдаёт
    // коллатераль/токены протоколу.
    for (const m of op.movement) {
      if (m.direction !== "out" || m.amount <= 0) continue;
      if (isGas(m)) continue;
      if (isStableSymbol(m.symbol)) continue;
      return `synthetic:${protoId}:${op.chain}:${m.symbol.toUpperCase()}:${walletId}`;
    }
    // UCB C10 fix: borrow (и withdraw, claim_rewards) ops имеют ТОЛЬКО IN
    // movement — для них marketKey тоже инферится по IN-asset. Без этого
    // inferMarketKey возвращал null → emitPositionEvent skip → my C10
    // self-loop inheritance не работала для Morpho borrow.
    //
    // UCB C5 Phase E2 (Task #18, dual_pipeline_equivalence regression):
    // Раньше `isStableSymbol` пропускался в IN loop, что ломало
    // cross-asset stable borrow (USDC against WBTC collateral): marketKey=null
    // → emitPositionEvent skip → borrowed USDC НЕ создавал lot → walker позже
    // на consume этого USDC падал в silent `m.usd` fallback. legacy build.ts
    // создавал lot всегда (cost=0 strict UCB). Теперь cross_protocol тоже
    // не skip'ает stable в IN-loop.
    for (const m of op.movement) {
      if (m.direction !== "in" || m.amount <= 0) continue;
      if (isGas(m)) continue;
      return `synthetic:${protoId}:${op.chain}:${m.symbol.toUpperCase()}:${walletId}`;
    }
  }
  return null;
}

function emitPositionEvent(
  op: ClassifiedOp,
  eventType: PositionEventType,
  marketKey: string,
  walletId: string,
  walletName: string,
  positions: PositionTracker,
  lots: LotTracker,
  histPrices: Map<string, number>,
  selfLoopCollateral: Map<string, { amount: number; totalCost: number }>,
  pendingWithdrawCost: Map<string, number>,
): void {
  const protoId = op.protocol?.id ?? "";
  const isReceipt = (m: TokenMovement) =>
    isReceiptOfProtocol(m.symbol, protoId, m.tokenId);

  const inTokens = op.movement
    .filter((m) => m.direction === "in" && m.amount > 0 && !isGas(m))
    .map((m) => ({
      symbol: m.symbol,
      amount: m.amount,
      usd: tokenUsdHist(m, op.chain, op.time, histPrices),
    }));

  // Out-tokens: для deposit_collateral консьюмим lots (cost basis transfer).
  const outRaw = op.movement.filter(
    (m) => m.direction === "out" && m.amount > 0 && !isGas(m),
  );
  const outTokens: { symbol: string; amount: number; usd: number }[] = [];
  let attributedCost = 0;
  for (const m of outRaw) {
    let lotCost = 0;
    // Receipt-токены отдаются в withdraw — для них consume lot напрямую.
    if (eventType === "deposit_collateral" && !isReceipt(m)) {
      const consumed = lots.consume({
        symbol: m.symbol,
        tokenId: m.tokenId,
        chain: op.chain,
        amount: m.amount,
        consumedAt: op.time,
        walletId,
      });
      // Owner-методика 2026-06-10: «доллар = доллар» — стейбл-оплата ВСЕГДА
      // по номиналу, НЕ по стоимости потреблённых стейбл-лотов (среди них
      // cost-0 лоты от borrow/rewards → фантомная «скидка»: testakk Artur
      // депозит 9 000 USDC в GM получал лот $3 091). lots.consume оставляем —
      // баланс стейблов вести нужно.
      lotCost = isStableSymbol(m.symbol) ? m.amount : consumed.totalCostUsd;
      // UCB C10: record consumed collateral cost basis для self-loop borrow
      // inheritance. consumedCost == 0 fallback на m.usd чтобы borrow
      // мог наследовать market-derived cost даже когда lots tracker пустой
      // (case lend_withdraw→supply chain где tracker не достал cost basis).
      const consumedCostForLoop =
        lotCost > 0
          ? lotCost
          : isStableSymbol(m.symbol)
            ? m.amount
            : tokenUsdHist(m, op.chain, op.time, histPrices);
      if (consumedCostForLoop > 0) {
        const key = `${walletId}|${protoId}|${m.symbol.toUpperCase()}`;
        const cur = selfLoopCollateral.get(key) ?? { amount: 0, totalCost: 0 };
        cur.amount += m.amount;
        cur.totalCost += consumedCostForLoop;
        selfLoopCollateral.set(key, cur);
      }
    } else if (eventType === "withdraw_collateral" && isReceipt(m)) {
      const consumed = lots.consume({
        symbol: m.symbol,
        tokenId: m.tokenId,
        chain: op.chain,
        amount: m.amount,
        consumedAt: op.time,
        walletId,
      });
      lotCost = consumed.totalCostUsd;
    }
    const fallbackUsd = isStableSymbol(m.symbol)
      ? m.amount
      : tokenUsdHist(m, op.chain, op.time, histPrices);
    const usd = lotCost > 0 ? lotCost : fallbackUsd;
    if (lotCost > 0) attributedCost += lotCost;
    // UCB: стейбл-OUT без cost-basis лота (= занятый/нетрассированный USDC,
    // напр. Morpho borrow → купить PT в leverage-петле) — это РЕАЛЬНО
    // потраченные доллары. Считаем по номиналу ($1), а НЕ роняем receipt
    // на его market-ценник (anti-recurrence #1: receipt m.usd ≠ уплаченное).
    // «Доллар = доллар, даже занятый»; долг учитывается отдельно (netStartUsd).
    // Non-stable с lotCost=0 остаётся strict-0 (Phase I: WBTC withdraw @market
    // раздувал бы downstream consume) — поэтому ветка ТОЛЬКО для стейблов.
    else if (isStableSymbol(m.symbol)) attributedCost += m.amount;
    outTokens.push({ symbol: m.symbol, amount: m.amount, usd });
  }

  // Withdraw_collateral: возвращаем cost basis в lots (in-side underlying
  // получает recovered cost пропорционально amount).
  //
  // **UCB Phase I (2026-05-24, regression артур POS-005)**: cost для
  // underlying lot — ИСКЛЮЧИТЕЛЬНО `attributedCost` (из receipt lots).
  // Если attributedCost = 0 → создаём lot с cost = 0 (strict UCB), НЕ
  // подменяем на market m.usd. Подмена на market = anti-recurrence
  // pattern #1 (silent fallback): WBTC withdraw @ market $95k → next
  // supply consume @ $95k × 0.226 = $21,613 при реальной trate $3,000.
  //
  // Pre-Phase-I: Phase 3 v2 (PR #12) ввёл `totalInUsd` fallback чтобы
  // build.self_loop.test.ts UCB C12 test проходил (он ожидал что lot
  // существует). Но C12 НЕ проверяет cost — только что лот существует.
  // Cost=0 satisfies test и НЕ inflates downstream consume.
  //
  // **Создаём lot всегда** (даже когда attributedCost=0): инвариант
  // amount-баланса требует чтобы выведенные underlying появились
  // в lots (иначе следующий swap/supply этого underlying не найдёт
  // их и упадёт в walker silent fallback). Просто cost=0.
  if (
    eventType === "withdraw_collateral" &&
    (attributedCost > 0 || inTokens.length > 0)
  ) {
    // Owner-методика 2026-06-10 (async-withdraw carry): Tx A (burn receipt,
    // ноги придут отдельной tx) — стоимость НЕ выбрасываем, паркуем по hash;
    // Tx B (ноги без receipt-out) забирает её через linkedHash.
    let carryCost = attributedCost;
    const linkedHash = (op as { linkedHash?: string }).linkedHash;
    if (carryCost > 0 && inTokens.length === 0) {
      pendingWithdrawCost.set(op.hash, carryCost);
    } else if (carryCost <= 0 && linkedHash) {
      const parked = pendingWithdrawCost.get(linkedHash);
      if (parked != null && parked > 0) {
        carryCost = parked;
        pendingWithdrawCost.delete(linkedHash);
      }
    }

    // Распределение стоимости по ногам (owner-методика, locked 2026-06-10):
    // стейбл-нога забирает свою долю ПО НОМИНАЛУ ($1=$1, cap'нуто общей
    // стоимостью), весь ОСТАТОК ложится на волатильные ноги (по USD-долям
    // между ними). Излишек стейбла сверх стоимости = реализованный gain;
    // нехватка — реализованный loss. Это сохраняет деньги:
    // Σ(стоимость ног) = списанная стоимость receipt-лотов.
    const stables = inTokens.filter((t) => isStableSymbol(t.symbol));
    const vols = inTokens.filter((t) => !isStableSymbol(t.symbol));
    const stableFace = stables.reduce((s, t) => s + t.amount, 0);
    const stableCost = Math.min(stableFace, carryCost);
    const residual = Math.max(0, carryCost - stableCost);
    const volUsd = vols.reduce((s, t) => s + t.usd, 0);

    for (const t of inTokens) {
      let costForLot: number;
      if (carryCost <= 0) {
        // Receipt-less возврат залога (Morpho withdrawCollateral → теперь
        // lend_withdraw, owner 2026-06-10): наследуем стоимость из C10
        // selfLoopCollateral-пула (туда её положил lend_supply того же
        // актива в тот же протокол). Нет пула → strict UCB Phase I ($0).
        costForLot = 0;
        const slKey = `${walletId}|${protoId}|${t.symbol.toUpperCase()}`;
        const slPool = selfLoopCollateral.get(slKey);
        if (slPool && slPool.amount > 0 && slPool.totalCost > 0) {
          const inheritAmount = Math.min(t.amount, slPool.amount);
          const pricePerUnit = slPool.totalCost / slPool.amount;
          costForLot = inheritAmount * pricePerUnit;
          slPool.amount -= inheritAmount;
          slPool.totalCost -= costForLot;
          if (slPool.amount <= 1e-9) selfLoopCollateral.delete(slKey);
          else selfLoopCollateral.set(slKey, slPool);
        }
      } else if (isStableSymbol(t.symbol)) {
        costForLot =
          stableFace > 0 ? stableCost * (t.amount / stableFace) : 0;
      } else {
        const share = volUsd > 0 ? t.usd / volUsd : 1 / Math.max(1, vols.length);
        costForLot = residual * share;
      }
      lots.acquire({
        symbol: t.symbol,
        tokenId: "",
        chain: op.chain,
        amount: t.amount,
        costPerUnitUsd: t.amount > 0 ? costForLot / t.amount : 0,
        acquiredAt: op.time,
        acquiredVia:
          op.type === "lp_remove"
            ? ("lp_close" as AcquiredVia)
            : ("lend_withdraw" as AcquiredVia),
        sourceHash: op.hash,
        walletId,
      });
      t.usd = costForLot;
    }
  }

  // Deposit_collateral: receipt-токены in-side создают lot с cost = attributedCost
  // (cross-protocol cost basis carries — главное!).
  //
  // UCB C8 (async-deposit pattern): GMX V2 / GMSOL / Adrena делают
  // 2-фазный депозит — Tx A (yield-deposit) шлёт USDC OUT, Tx B (yield-
  // deposit-fill) получает GLV/GM IN. На Tx B нет OUT underlying → без
  // C8 attributedCost = 0 → GLV lot с cost = 0 → дальнейшие операции
  // (Morpho supply GLV → POS-006) fallback на market m.usd.
  //
  // `async_deposit_linker.ts` пишет `linkedCostBasisUsd` на Tx B =
  // Σ outgoing.usd Tx A. Используем его если attributedCost = 0.
  if (eventType === "deposit_collateral") {
    const receiptIns = op.movement.filter(
      (m) => m.direction === "in" && isReceipt(m) && m.amount > 0,
    );
    // Owner-методика 2026-06-10 (симметрично withdraw-carry): async-deposit
    // creator (Tx A) уже посчитал НАСТОЯЩУЮ стоимость оплаты (stable по
    // номиналу + consumed лоты волатильной оплаты) — паркуем её; fill (Tx B)
    // забирает по linkedHash. Это ПРИОРИТЕТНЕЕ linkedCostBasisUsd из линкера:
    // тот суммирует sync-priced movement.usd (POS-005 класс — testakk 0x450b:
    // ETH-оплата 2.5 ETH по sync-цене $4 063 вместо $6 624 из лотов).
    const depositLinkedHash = (op as { linkedHash?: string }).linkedHash;
    if (
      attributedCost > 0 &&
      receiptIns.length === 0 &&
      depositLinkedHash != null
    ) {
      pendingWithdrawCost.set(op.hash, attributedCost);
    }
    const parkedCost =
      receiptIns.length > 0 && depositLinkedHash != null
        ? pendingWithdrawCost.get(depositLinkedHash)
        : undefined;
    if (parkedCost != null && depositLinkedHash != null) {
      pendingWithdrawCost.delete(depositLinkedHash);
    }
    const linkedCost = (op as { linkedCostBasisUsd?: number })
      .linkedCostBasisUsd;
    const useLinkedCost =
      linkedCost != null &&
      Number.isFinite(linkedCost) &&
      linkedCost > 0 &&
      attributedCost <= 0;
    let totalCostForReceipts =
      parkedCost != null && parkedCost > 0 && attributedCost <= 0
        ? parkedCost
        : useLinkedCost
          ? linkedCost!
          : attributedCost;
    // UCB C5 Phase 3 v2 (Task #18): legacy `build.ts:handleSupply` создавал
    // receipt lot с cost = m.usd когда не было ни attributedCost (нет
    // out-side underlying) ни linkedCostBasisUsd (standalone mint без
    // async-deposit linker). Это покрывает случай "standalone fallback to
    // market" (build.async_deposit.test.ts). Берём market value receipt-in'ов.
    if (totalCostForReceipts <= 0 && receiptIns.length > 0) {
      const receiptMarketSum = receiptIns.reduce(
        (s, m) => s + tokenUsdHist(m, op.chain, op.time, histPrices),
        0,
      );
      if (receiptMarketSum > 0) totalCostForReceipts = receiptMarketSum;
    }
    if (receiptIns.length > 0 && totalCostForReceipts > 0) {
      const totalRecv = receiptIns.reduce((s, m) => s + m.amount, 0);
      for (const m of receiptIns) {
        const share = (m.amount / totalRecv) * totalCostForReceipts;
        lots.acquire({
          symbol: m.symbol,
          tokenId: m.tokenId,
          chain: op.chain,
          amount: m.amount,
          costPerUnitUsd: share / m.amount,
          acquiredAt: op.time,
          acquiredVia: useLinkedCost
            ? ("linked_async_fill" as AcquiredVia)
            : attributedCost > 0
              ? ("linked_async_fill" as AcquiredVia)
              : ("buy_with_stable" as AcquiredVia),
          sourceHash: op.hash,
          walletId,
        });
      }
    }
  }

  // UCB C10: borrow event — создаёт lot для borrowed proceeds. Если same
  // asset из ТОГО ЖЕ protocol только что был consumed как collateral
  // (selfLoopCollateral!), inherit cost basis pro-rata. Иначе $0 (strict
  // UCB — debt is not own money). Раньше этот код висел в
  // deposit_collateral ветке → никогда не активировался для borrow ops
  // (mapOpToEventType("borrow") === "borrow", не "deposit_collateral").
  if (eventType === "borrow") {
    const borrowIns = op.movement.filter(
      (m) => m.direction === "in" && !isReceipt(m) && m.amount > 0,
    );
    for (const m of borrowIns) {
      let costPerUnitUsd = 0;
      let acquiredVia: AcquiredVia = "borrow";
      const key = `${walletId}|${protoId}|${m.symbol.toUpperCase()}`;
      const pool = selfLoopCollateral.get(key);
      if (pool && pool.amount > 0 && pool.totalCost > 0) {
        const inheritAmount = Math.min(m.amount, pool.amount);
        const pricePerUnit = pool.totalCost / pool.amount;
        const inheritedCost = inheritAmount * pricePerUnit;
        costPerUnitUsd =
          inheritAmount >= m.amount
            ? pricePerUnit
            : inheritedCost / m.amount; // pro-rata: inherited part, rest @ 0
        acquiredVia = "borrow_self_loop";
        pool.amount -= inheritAmount;
        pool.totalCost -= inheritedCost;
        if (pool.amount <= 1e-9) selfLoopCollateral.delete(key);
        else selfLoopCollateral.set(key, pool);
      }
      lots.acquire({
        symbol: m.symbol,
        tokenId: m.tokenId,
        chain: op.chain,
        amount: m.amount,
        costPerUnitUsd,
        acquiredAt: op.time,
        acquiredVia,
        sourceHash: op.hash,
        walletId,
      });
    }
  }

  let receiptDelta = 0;
  for (const m of op.movement) {
    if (!isReceipt(m)) continue;
    if (m.direction === "in") receiptDelta += m.amount;
    else if (m.direction === "out") receiptDelta -= m.amount;
  }

  const event: PositionEvent = {
    time: op.time,
    hash: op.hash,
    type: eventType,
    inTokens,
    outTokens,
    receiptDelta,
    ...((op.notes?.length ?? 0) > 0
      ? { note: (op.notes as string[]).join(", ") }
      : {}),
  };

  positions.recordEvent(
    walletId,
    walletName,
    protoId,
    op.protocol?.name ?? protoId,
    op.chain,
    marketKey,
    event,
  );
}

function mapOpToEventType(opType: string): PositionEventType | null {
  switch (opType) {
    case "lp_add":
    case "lend_supply":
    case "stake":
      return "deposit_collateral";
    case "lp_remove":
    case "lend_withdraw":
    case "unstake":
      return "withdraw_collateral";
    case "borrow":
      return "borrow";
    case "repay":
      return "repay";
    case "claim_rewards":
      return "claim_rewards";
    default:
      return null;
  }
}
