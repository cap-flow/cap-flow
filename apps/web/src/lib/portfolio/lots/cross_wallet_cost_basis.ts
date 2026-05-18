/**
 * UCB C3 — cross-wallet transfer/bridge cost basis inheritance.
 *
 * Closes the gap that A2 (`findInternalTransferPairs`) leaves: A2 matches
 * pairs and marks them as internal, but doesn't propagate cost basis из
 * source wallet's WAC. D5 покрывает same-wallet bridge_out → bridge_in;
 * **C3 покрывает cross-wallet** transfers и bridges.
 *
 * **Why separate from C2 (fiat_hop)?**
 *   - C2 specific scope: `withdraw_fiat` ↔ `deposit_fiat` (CEX-loops);
 *     allows same-wallet (CEX hop не зависит от wallet).
 *   - C3 broader: `{transfer_out, bridge_out, withdraw_fiat}` ↔
 *     `{transfer_in, bridge_in, deposit_fiat}` mixed pairs; **cross-wallet
 *     only** (same-wallet bridges already handled by D5).
 *
 * Two modules сосуществуют в `LoadedWalletsProvider` без конфликтов:
 * each fills a unique slot in the override map (C2 → fiat ops same-wallet;
 * C3 → cross-wallet всё). Если pair матчится обоими (теоретически),
 * MERGE priority — fiat-hop loses (CEX hop через CEX > simple transfer).
 *
 * Algorithm — identical to C2 with one rule change:
 *   - skip same-wallet pairs (D5 handles those).
 *   - all 6 type combinations allowed (out_types × in_types).
 *   - greedy nearest-time, ±5%/10% tolerance, ±6h window, OUT precedes IN.
 *   - source tracker excludes the matched OUT op для pre-consume wacAt.
 */

import { isStableSymbol, tokenFamily } from "../protocols";
import type { ClassifiedOp } from "../types";
import { buildLotTrackerFromOps } from "./build";

const TIME_WINDOW_SEC = 6 * 60 * 60;
const AMOUNT_TOL_VOLATILE = 0.05;
const AMOUNT_TOL_STABLE = 0.1;

const OUT_OP_TYPES = new Set(["transfer_out", "bridge_out", "withdraw_fiat"]);
const IN_OP_TYPES = new Set(["transfer_in", "bridge_in", "deposit_fiat"]);

interface OutSlot {
  walletId: string;
  hash: string;
  time: number;
  symbol: string;
  family: string;
  amount: number;
  used: boolean;
}

interface InSlot {
  walletId: string;
  hash: string;
  time: number;
  symbol: string;
  family: string;
  amount: number;
}

/**
 * Найти cross-wallet transfer/bridge pairs и вернуть cost basis overrides.
 *
 * @param opsByWallet  Map<walletId, ClassifiedOp[]> — все ops user'а.
 * @param preExistingOverrides  Уже накопленные A4 / D3 / C2 overrides
 *                              (применяются при построении source tracker'а
 *                              для multi-hop chain inheritance).
 */
export function computeCrossWalletCostBasisOverrides(
  opsByWallet: ReadonlyMap<string, ClassifiedOp[]>,
  preExistingOverrides: ReadonlyMap<string, number>,
): Map<string, number> {
  const out = new Map<string, number>();

  // Step 1: Collect OUT and IN slots.
  const outs: OutSlot[] = [];
  const ins: InSlot[] = [];

  for (const [walletId, ops] of opsByWallet) {
    for (const op of ops) {
      if (op.status === "failed") continue;
      if (OUT_OP_TYPES.has(op.type)) {
        for (const m of op.movement) {
          if (m.direction !== "out" || m.amount <= 0) continue;
          outs.push({
            walletId,
            hash: op.hash,
            time: op.time,
            symbol: m.symbol,
            family: tokenFamily(m.symbol),
            amount: m.amount,
            used: false,
          });
        }
      } else if (IN_OP_TYPES.has(op.type)) {
        for (const m of op.movement) {
          if (m.direction !== "in" || m.amount <= 0) continue;
          ins.push({
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

  if (outs.length === 0 || ins.length === 0) return out;

  // Step 2: greedy nearest-time match by family + amount tolerance, but
  // **only cross-wallet** (same-wallet excluded — D5 + C2 cover those).
  ins.sort((a, b) => a.time - b.time);

  const outsByFamily = new Map<string, OutSlot[]>();
  for (const o of outs) {
    if (!outsByFamily.has(o.family)) outsByFamily.set(o.family, []);
    outsByFamily.get(o.family)!.push(o);
  }

  type Match = { out: OutSlot; in: InSlot };
  const matches: Match[] = [];

  for (const inSlot of ins) {
    const cands = outsByFamily.get(inSlot.family);
    if (!cands) continue;
    const tol = isStableSymbol(inSlot.symbol)
      ? AMOUNT_TOL_STABLE
      : AMOUNT_TOL_VOLATILE;

    let best: OutSlot | null = null;
    let bestDt = Infinity;
    for (const o of cands) {
      if (o.used) continue;
      // **Cross-wallet only**: same-wallet handled by D5 (bridge) or C2 (fiat).
      if (o.walletId === inSlot.walletId) continue;
      if (o.time > inSlot.time) continue;
      const dt = Math.abs(o.time - inSlot.time);
      if (dt > TIME_WINDOW_SEC) continue;
      const amtDiff =
        Math.abs(o.amount - inSlot.amount) / Math.max(o.amount, 1e-9);
      if (amtDiff > tol) continue;
      if (dt < bestDt) {
        best = o;
        bestDt = dt;
      }
    }

    if (best) {
      best.used = true;
      matches.push({ out: best, in: inSlot });
    }
  }

  if (matches.length === 0) return out;

  // Step 3: для каждого match — fresh LotTracker на source wallet's ops
  // EXCLUDING the matched out-op (pre-consume wacAt), с preExistingOverrides
  // applied для multi-hop chain inheritance.
  const trackerCache = new Map<string, ReturnType<typeof buildLotTrackerFromOps>>();

  for (const { out: outSlot, in: inSlot } of matches) {
    const cacheKey = `${outSlot.walletId}|${outSlot.hash.toLowerCase()}`;
    let tracker = trackerCache.get(cacheKey);
    if (!tracker) {
      const sourceOps = opsByWallet.get(outSlot.walletId) ?? [];
      const filtered = sourceOps.filter((o) => o.hash !== outSlot.hash);
      tracker = buildLotTrackerFromOps(filtered, {
        walletId: outSlot.walletId,
        histPrices: new Map(),
        costBasisOverrideByHash:
          preExistingOverrides.size > 0
            ? new Map(preExistingOverrides)
            : new Map(),
      });
      trackerCache.set(cacheKey, tracker);
    }

    let wac = tracker.wacAt(outSlot.walletId, outSlot.symbol, outSlot.time);
    if (wac == null || wac <= 0) {
      wac = tracker.wacAt(outSlot.walletId, outSlot.family, outSlot.time);
    }

    if (wac != null && wac > 0) {
      out.set(inSlot.hash.toLowerCase(), wac * inSlot.amount);
    }
  }

  return out;
}
