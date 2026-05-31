/**
 * UCB C2 — CEX-loop cost basis inheritance.
 *
 * **The gap**: когда user снимает крипту с on-chain wallet'а на CEX
 * (`withdraw_fiat`) и возвращает на другой chain / wallet
 * (`deposit_fiat`), system теряет cost basis trail. Existing
 * `findInternalTransferPairs` skip'аeт same-wallet pairs (он создан для
 * cross-wallet bridges), а CEX D3 service помогает только если у user
 * подключен CEX account.
 *
 * **The fix**: новый pure-function детектор который:
 *   1. Матчит `withdraw_fiat` (OUT) ↔ `deposit_fiat` (IN) pairs по:
 *      - Token family (ETH/WETH через `tokenFamily`)
 *      - Amount tolerance: ±5% volatile, ±10% stable (CEX spread/fees)
 *      - Time window: ±6h (CEX deposits могут залипать)
 *      - Same-wallet OR cross-wallet — оба валидны (CEX-hop не зависит
 *        от того тот же ли это on-chain wallet)
 *   2. Для каждого match — строит LotTracker на source wallet's ops
 *      ДО `withdraw_fiat` (с pre-existing overrides A4/D3),
 *      читает `wacAt(walletId, family, withdraw.time)`, возвращает
 *      cost basis = `WAC × deposit.inAmount`.
 *
 * Output: `Map<deposit_fiat_hash, costBasisUsd>` готовый для merge в
 * `costBasisOverrideByHash`.
 *
 * **Это устраняет systemic bug** для всех users где деньги ходят
 * on-chain → CEX → on-chain (Vladimir POS-002 base case, и любые
 * similar scenarios).
 *
 * **Caveats v1**:
 *   - Single-pass: source wallet's tracker строится с pre-existing
 *     overrides only. Если source wallet's WAC сам пришёл из
 *     fiat-hop'а раньше — нужна итерация (v2 backlog).
 *   - Greedy nearest-time match: один withdraw → один deposit. Если
 *     user через CEX продал и купил снова разные суммы — heuristic
 *     может ошибиться. User может override через A4 annotations.
 *   - ±5%/10% tolerance + 6h window намеренно strict — false positives
 *     хуже false negatives (user не заметит missing inheritance, но
 *     incorrect inheritance ломает PnL).
 */

import { isStableSymbol, tokenFamily } from "../protocols.js";
import type { ClassifiedOp } from "../types.js";
import { buildLotTrackerFromOps } from "./build.js";

const TIME_WINDOW_SEC = 6 * 60 * 60; // ±6 hours
const AMOUNT_TOL_VOLATILE = 0.05; // ±5%
const AMOUNT_TOL_STABLE = 0.1; // ±10%

interface WithdrawSlot {
  walletId: string;
  hash: string;
  time: number;
  symbol: string;
  family: string;
  amount: number;
  used: boolean;
}

interface DepositSlot {
  walletId: string;
  hash: string;
  time: number;
  symbol: string;
  family: string;
  amount: number;
}

/**
 * Найти fiat-hop pairs и вернуть cost basis overrides для deposit_fiat side.
 *
 * @param opsByWallet  Map<walletId, ClassifiedOp[]> — все ops user'а
 *                     индексированные по wallet (composite OR UUID — не
 *                     важно, нужно только чтобы tracker строился на
 *                     тех же ops что и main pipeline).
 * @param preExistingOverrides  Уже накопленные overrides (A4 manual + D3 CEX).
 *                              Применяются при построении source tracker'а.
 */
export function computeFiatHopCostBasisOverrides(
  opsByWallet: ReadonlyMap<string, ClassifiedOp[]>,
  preExistingOverrides: ReadonlyMap<string, number>,
): Map<string, number> {
  const out = new Map<string, number>();

  // Step 1: собираем все withdraw_fiat / deposit_fiat ops с движениями.
  const withdraws: WithdrawSlot[] = [];
  const deposits: DepositSlot[] = [];

  for (const [walletId, ops] of opsByWallet) {
    for (const op of ops) {
      if (op.status === "failed") continue;
      if (op.type === "withdraw_fiat") {
        for (const m of op.movement) {
          if (m.direction !== "out" || m.amount <= 0) continue;
          withdraws.push({
            walletId,
            hash: op.hash,
            time: op.time,
            symbol: m.symbol,
            family: tokenFamily(m.symbol),
            amount: m.amount,
            used: false,
          });
        }
      } else if (op.type === "deposit_fiat") {
        for (const m of op.movement) {
          if (m.direction !== "in" || m.amount <= 0) continue;
          deposits.push({
            walletId,
            hash: op.hash,
            time: op.time,
            symbol: m.symbol,
            family: tokenFamily(m.symbol),
            amount: m.amount,
          });
        }
      }
    }
  }

  if (withdraws.length === 0 || deposits.length === 0) return out;

  // Step 2: для каждого deposit ищем ближайший withdraw в окне ±6h с
  // matching family и amount tolerance.
  // Sort deposits chronologically — ранние deposits матчатся первыми.
  deposits.sort((a, b) => a.time - b.time);

  // Per-family withdraw lookup (по family для быстрого поиска).
  const withdrawsByFamily = new Map<string, WithdrawSlot[]>();
  for (const w of withdraws) {
    if (!withdrawsByFamily.has(w.family)) withdrawsByFamily.set(w.family, []);
    withdrawsByFamily.get(w.family)!.push(w);
  }

  type Match = {
    withdraw: WithdrawSlot;
    deposit: DepositSlot;
  };
  const matches: Match[] = [];

  for (const dep of deposits) {
    const candidates = withdrawsByFamily.get(dep.family);
    if (!candidates) continue;

    const tol = isStableSymbol(dep.symbol) ? AMOUNT_TOL_STABLE : AMOUNT_TOL_VOLATILE;

    // Find unused, time-window-matching, amount-matching candidate
    // closest in time to deposit.
    let best: WithdrawSlot | null = null;
    let bestDt = Infinity;
    for (const w of candidates) {
      if (w.used) continue;
      const dt = Math.abs(w.time - dep.time);
      if (dt > TIME_WINDOW_SEC) continue;
      const amtDiff = Math.abs(w.amount - dep.amount) / Math.max(w.amount, 1e-9);
      if (amtDiff > tol) continue;
      // Withdraw must be BEFORE or simultaneous with deposit (cause → effect).
      if (w.time > dep.time) continue;
      if (dt < bestDt) {
        best = w;
        bestDt = dt;
      }
    }

    if (best) {
      best.used = true;
      matches.push({ withdraw: best, deposit: dep });
    }
  }

  if (matches.length === 0) return out;

  // Step 3: для каждого match — строим LotTracker на source wallet's ops
  // с EXCLUDING this withdraw_fiat (чтобы прочитать WAC ДО consume).
  //
  // `wacAt(time)` читает remaining amount всех lots с `acquiredAt <= time`.
  // Если withdraw_fiat применён, lot мог быть полностью consumed (amount = 0),
  // тогда `wacAt` returns null. Решение: filter out этот withdraw_fiat при
  // построении tracker'а для расчёта его cost basis для deposit'а.
  //
  // Per-wallet+excludedHash cache: typically один wallet → 1-3 matches.
  const trackerCache = new Map<string, ReturnType<typeof buildLotTrackerFromOps>>();
  for (const { withdraw, deposit } of matches) {
    const cacheKey = `${withdraw.walletId}|${withdraw.hash.toLowerCase()}`;
    let tracker = trackerCache.get(cacheKey);
    if (!tracker) {
      const sourceOps = opsByWallet.get(withdraw.walletId) ?? [];
      // Exclude THIS specific withdraw_fiat — иначе его consume опустошает lot.
      const filtered = sourceOps.filter((o) => o.hash !== withdraw.hash);
      tracker = buildLotTrackerFromOps(filtered, {
        walletId: withdraw.walletId,
        histPrices: new Map(),
        // Important: tracker строится с уже-известными A4/D3 overrides.
        // Это даёт correct WAC даже когда source lot пришёл с CEX trail.
        costBasisOverrideByHash:
          preExistingOverrides.size > 0
            ? new Map(preExistingOverrides)
            : new Map(),
      });
      trackerCache.set(cacheKey, tracker);
    }

    // tokenFamily-based lookup: token symbol может различаться (WETH vs
    // ETH). LotTracker keyed по normalized symbol, поэтому пробуем оба.
    let wac = tracker.wacAt(withdraw.walletId, withdraw.symbol, withdraw.time);
    if (wac == null || wac <= 0) {
      wac = tracker.wacAt(withdraw.walletId, withdraw.family, withdraw.time);
    }

    if (wac != null && wac > 0) {
      const costBasis = wac * deposit.amount;
      out.set(deposit.hash.toLowerCase(), costBasis);
    }
  }

  return out;
}
