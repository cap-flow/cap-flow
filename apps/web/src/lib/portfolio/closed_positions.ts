/**
 * Архив закрытых позиций.
 *
 * Реконструируем закрытые позиции из истории операций (lp_add → lp_remove,
 * lend_supply → lend_withdraw, stake → unstake) — пары open→close для
 * каждого протокола.
 *
 * Архив используется ТОЛЬКО для отображения истории — он НЕ участвует в
 * расчёте текущего PnL, APR, дашборда. Это «лента событий», как банковская
 * выписка по закрытым позициям.
 *
 * Алгоритм (per wallet+protocol+chain):
 *   1. Сортируем все open/close events хронологически.
 *   2. Trail running balance per-symbol (out → +, in → −).
 *   3. Когда после CLOSE все balances ≤ 0 → cycle закрылся. Записываем
 *      пару { openedAt: первый open этого цикла, closedAt: время полного
 *      закрытия, depositedUsd, withdrawnUsd, claimedRewardsUsd }.
 *   4. Если закрытия не было → позиция всё ещё открыта, в архив не идёт.
 */

import { defillamaCoinKey, priceFromMap } from "@/lib/defillama";
import { isJunkOp } from "./junk_filter";
import { isStableSymbol } from "./protocols";
import type { ClassifiedOp } from "./types";
import type { SavedWallet } from "@/lib/wallets";

const OPEN_TYPES = new Set<ClassifiedOp["type"]>([
  "lend_supply",
  "lp_add",
  "stake",
  "perp_open",
]);

const CLOSE_TYPES = new Set<ClassifiedOp["type"]>([
  "lend_withdraw",
  "lp_remove",
  "unstake",
  "perp_close",
]);

function normalizeSymbol(s: string): string {
  const u = s.toUpperCase();
  if (u === "WETH") return "ETH";
  return u;
}

export interface ClosedPosition {
  /** Стабильный id для UI (`CLOSED-001` ...). */
  id: string;
  walletId: string;
  walletName: string;
  walletChain: SavedWallet["chain"];
  chain: string;
  protocol: { id: string; name: string };
  /** Когда был первый OPEN текущего (закрытого) цикла. */
  openedAt: number;
  /** Когда баланс позиции окончательно ушёл в 0 (для unmatched — последний event). */
  closedAt: number;
  /** Срок жизни в днях (closedAt − openedAt). */
  ageDays: number;
  /** Тип позиции (выводится по преобладающему open op.type). */
  kind: "lending" | "lp" | "staking" | "perp" | "other";
  /** Σ депозитов в USD за этот цикл. */
  depositedUsd: number;
  /** Σ выводов в USD за этот цикл. */
  withdrawnUsd: number;
  /** Σ claim_rewards между openedAt и closedAt. */
  claimedRewardsUsd: number;
  /** Финальный PnL = withdrawnUsd + claimedRewardsUsd − depositedUsd. */
  pnlUsd: number;
  /** Символы supply токенов в этой позиции. */
  symbols: string[];
  /**
   * Тип закрытия:
   *  - `complete` — running balance вышел в 0 (классический close).
   *  - `unmatched` — running balance > 0 (classifier не распознал
   *    последний withdraw, или позиция реально открыта, но live API
   *    её не покрывает). По умолчанию ведём в архив, потому что для
   *    multi-protocol реальности это чаще закрытая позиция.
   */
  closureType: "complete" | "unmatched";
}

interface CycleAcc {
  openOps: ClassifiedOp[];
  closeOps: ClassifiedOp[];
  // running balance per symbol — для определения момента полного закрытия
  balanceBySym: Map<string, number>;
  // все симвoлы которые когда-либо появлялись (для итогового списка)
  allSymbols: Set<string>;
  startTime: number; // время первого OPEN текущего цикла
}

interface BuildInput {
  wallet: SavedWallet;
  ops: ClassifiedOp[];
}

function newCycle(): CycleAcc {
  return {
    openOps: [],
    closeOps: [],
    balanceBySym: new Map(),
    allSymbols: new Set(),
    startTime: 0,
  };
}

function kindFromCategory(cat: string): ClosedPosition["kind"] {
  const c = cat.toLowerCase();
  if (c.includes("lend") || c.includes("cdp") || c.includes("borrow"))
    return "lending";
  if (c.includes("lp") || c.includes("liquidity") || c.includes("yield"))
    return "lp";
  if (c.includes("stak") || c.includes("restak")) return "staking";
  if (c.includes("perp")) return "perp";
  return "other";
}

function inferKindFromOpsType(
  ops: ClassifiedOp[],
): ClosedPosition["kind"] {
  // Берём kind из самого «характерного» open-op'а (если protocol.category
  // есть). Иначе по типу события.
  for (const op of ops) {
    if (op.protocol?.category) return kindFromCategory(op.protocol.category);
    if (op.type === "lp_add") return "lp";
    if (op.type === "lend_supply") return "lending";
    if (op.type === "stake") return "staking";
    if (op.type === "perp_open") return "perp";
  }
  return "other";
}

function finalizeCycle(
  acc: CycleAcc,
  closeTime: number,
  rewardsByCycle: Map<string, number>,
  cycleKey: string,
  walletId: string,
  walletName: string,
  walletChain: SavedWallet["chain"],
  chain: string,
  protocol: { id: string; name: string },
  closureType: ClosedPosition["closureType"],
  histPrices?: Map<string, number>,
): ClosedPosition | null {
  if (acc.openOps.length === 0) return null;
  // Helper: цена движения = historical (из DefiLlama hourly bucket'а на op.time)
  // если доступна, иначе fallback на m.usd (current spot — искажает long-term).
  function movementUsd(
    m: { symbol: string; tokenId: string; usd: number | null; amount: number },
    opTime: number,
    opChain: string,
  ): number {
    if (m.amount <= 0) return 0;
    if (histPrices && histPrices.size > 0) {
      if (isStableSymbol(m.symbol)) return m.amount * 1;
      const coin = defillamaCoinKey(opChain, m.tokenId, m.symbol);
      if (coin) {
        const hp = priceFromMap(histPrices, coin, opTime);
        if (hp != null && hp > 0) return m.amount * hp;
      }
    }
    return m.usd ?? 0;
  }
  let depositedUsd = 0;
  for (const op of acc.openOps) {
    for (const m of op.movement) {
      if (m.direction !== "out" || m.amount <= 0) continue;
      depositedUsd += movementUsd(m, op.time, op.chain);
    }
  }
  let withdrawnUsd = 0;
  for (const op of acc.closeOps) {
    for (const m of op.movement) {
      if (m.direction !== "in" || m.amount <= 0) continue;
      withdrawnUsd += movementUsd(m, op.time, op.chain);
    }
  }
  const claimedRewardsUsd = rewardsByCycle.get(cycleKey) ?? 0;
  const pnlUsd = withdrawnUsd + claimedRewardsUsd - depositedUsd;
  const ageDays = Math.max(
    0,
    Math.floor((closeTime - acc.startTime) / 86_400),
  );
  return {
    id: "", // выставится снаружи
    walletId,
    walletName,
    walletChain,
    chain,
    protocol,
    openedAt: acc.startTime,
    closedAt: closeTime,
    ageDays,
    kind: inferKindFromOpsType(acc.openOps),
    depositedUsd,
    withdrawnUsd,
    claimedRewardsUsd,
    pnlUsd,
    symbols: [...acc.allSymbols].sort(),
    closureType,
  };
}

/**
 * Реконструирует закрытые позиции из истории операций для всех кошельков.
 *
 * Архив включает ДВА типа закрытий:
 *  - `complete`: running balance после close == 0 (явный full close).
 *  - `unmatched`: позиция была открыта, но цикл не закрылся в истории по
 *    REMOVE-типам. Если этот `(walletId, protocolId, chain)` НЕ
 *    представлен в `liveKeys` (live API его не видит) — почти всегда
 *    позиция была закрыта on-chain, просто classifier не распознал
 *    withdraw как `lp_remove`/`lend_withdraw`. Ведём такие в архив.
 *
 * Если позиция в `liveKeys` — она показывается на странице открытых
 * позиций. Её незакрытый цикл из истории НЕ дублируется в архив.
 *
 * @param liveKeys Set ключей `${walletId}|${chain}|${protocolId}` —
 *                 позиции, которые live API сейчас возвращает как
 *                 активные. Передаётся из buildOpenPositions.
 */
export function buildClosedPositions(
  loaded: BuildInput[],
  liveKeys?: Set<string>,
  /**
   * DefiLlama historical prices (hourly buckets). Используются для **точного**
   * расчёта `depositedUsd`/`withdrawnUsd`/`claimedRewardsUsd` на момент tx,
   * а не по текущей цене (DeBank `m.usd`). Без этого параметра PnL закрытых
   * долгосрочных позиций искажается в разы (баг 2026-05-09: ETH-позиция
   * 6 мес назад при $1500 показывала startUsd при сегодняшних $4000).
   */
  histPrices?: Map<string, number>,
): ClosedPosition[] {
  const out: ClosedPosition[] = [];

  for (const l of loaded) {
    // Группируем ops по (protocolId, chain) — каждая группа = независимая
    // временная линия позиций.
    const byProto = new Map<string, ClassifiedOp[]>();
    for (const op of l.ops) {
      if (op.status === "failed") continue;
      if (!op.protocol) continue;
      const key = `${op.protocol.id}|${op.chain}`;
      const arr = byProto.get(key) ?? [];
      arr.push(op);
      byProto.set(key, arr);
    }

    for (const [protoKey, ops] of byProto) {
      // Хронологическая сортировка.
      const sorted = [...ops].sort((a, b) => a.time - b.time);

      // Получим referenced protocol (берём первый non-null).
      const protoSrc = sorted.find((o) => o.protocol)!;
      const proto = {
        id: protoSrc.protocol!.id,
        name: protoSrc.protocol!.name,
      };
      const chain = protoSrc.chain;

      // Rewards по этому протоколу — собираем по cycleKey
      // (claim_rewards не привязаны к open/close, относим к текущему циклу).
      const rewardsByCycle = new Map<string, number>();

      let acc = newCycle();
      let cycleIdx = 0;

      for (const op of sorted) {
        if (op.type === "claim_rewards") {
          // rewards относятся к текущему циклу (если он открыт)
          if (acc.openOps.length > 0) {
            const key = `${protoKey}#${cycleIdx}`;
            let claimed = 0;
            for (const m of op.movement) {
              if (m.direction !== "in" || m.amount <= 0) continue;
              // Historical price на момент tx — иначе claim'ы 6-мес давности
              // считаются по сегодняшней цене.
              if (histPrices && histPrices.size > 0) {
                if (isStableSymbol(m.symbol)) {
                  claimed += m.amount;
                  continue;
                }
                const coin = defillamaCoinKey(op.chain, m.tokenId, m.symbol);
                if (coin) {
                  const hp = priceFromMap(histPrices, coin, op.time);
                  if (hp != null && hp > 0) {
                    claimed += m.amount * hp;
                    continue;
                  }
                }
              }
              if (m.usd != null && m.usd > 0) claimed += m.usd;
            }
            rewardsByCycle.set(
              key,
              (rewardsByCycle.get(key) ?? 0) + claimed,
            );
          }
          continue;
        }

        if (OPEN_TYPES.has(op.type)) {
          if (acc.openOps.length === 0) acc.startTime = op.time;
          acc.openOps.push(op);
          for (const m of op.movement) {
            if (m.direction !== "out" || m.amount <= 0) continue;
            const sym = normalizeSymbol(m.symbol);
            acc.balanceBySym.set(
              sym,
              (acc.balanceBySym.get(sym) ?? 0) + m.amount,
            );
            acc.allSymbols.add(m.symbol);
          }
        } else if (CLOSE_TYPES.has(op.type)) {
          if (acc.openOps.length === 0) continue; // close без открытого цикла — пропускаем
          acc.closeOps.push(op);
          for (const m of op.movement) {
            if (m.direction !== "in" || m.amount <= 0) continue;
            const sym = normalizeSymbol(m.symbol);
            acc.balanceBySym.set(
              sym,
              (acc.balanceBySym.get(sym) ?? 0) - m.amount,
            );
          }
          // Проверяем — все ли баланс ≤ 0?
          let allClosed = true;
          for (const v of acc.balanceBySym.values()) {
            if (v > 1e-6) {
              allClosed = false;
              break;
            }
          }
          if (allClosed) {
            // Цикл закрылся — финализируем как `complete`.
            const closed = finalizeCycle(
              acc,
              op.time,
              rewardsByCycle,
              `${protoKey}#${cycleIdx}`,
              l.wallet.id,
              l.wallet.name,
              l.wallet.chain,
              chain,
              proto,
              "complete",
              histPrices,
            );
            if (closed) out.push(closed);
            acc = newCycle();
            cycleIdx += 1;
          }
        }
      }
      // После цикла по ops — проверим: остался ли «висящий» open-цикл,
      // который не закрылся? Если да И этот (walletId, protocolId, chain)
      // НЕ представлен в live (т.е. live API не видит позицию) → почти
      // всегда позиция реально закрыта, просто classifier не распознал
      // последний withdraw. Ведём в архив с пометкой `unmatched`.
      const liveKey = `${l.wallet.id}|${chain}|${proto.id}`;
      const isLive = liveKeys?.has(liveKey) ?? false;
      if (acc.openOps.length > 0 && !isLive) {
        // closeTime — время последнего относящегося к циклу события.
        const lastEvent = acc.closeOps.at(-1) ?? acc.openOps.at(-1)!;
        const unmatched = finalizeCycle(
          acc,
          lastEvent.time,
          rewardsByCycle,
          `${protoKey}#${cycleIdx}`,
          l.wallet.id,
          l.wallet.name,
          l.wallet.chain,
          chain,
          proto,
          "unmatched",
          histPrices,
        );
        if (unmatched) out.push(unmatched);
      }
    }
  }

  // Сортируем по closedAt desc — самые свежие закрытия наверху.
  out.sort((a, b) => b.closedAt - a.closedAt);

  return out.map((p, i) => ({
    ...p,
    id: `CLOSED-${String(i + 1).padStart(3, "0")}`,
  }));
}
