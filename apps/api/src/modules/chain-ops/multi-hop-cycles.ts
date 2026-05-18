/**
 * UCB A5.2: multi-hop self-bridge cycle detector.
 *
 * Расширение A5 (2-hop only). Здесь — N-leg loops A→B→C→...→A.
 *
 * Algorithm:
 *   1. Sort pairs chronologically by `outOpTimeSec`.
 *   2. Для каждого pair P start: запускаем DFS, walking forward
 *      (next leg's outTime > current leg's inTime).
 *   3. Если path возвращается в `originWalletId` — cycle found.
 *   4. Window cap (14d) prevents stale matches.
 *   5. Greedy: каждый pair используется только в одном cycle.
 *
 * Length cap: 6 legs (защита от unbounded DFS на больших датасетах).
 */
import { tokenFamily, type MatchedCrossChainPair } from "./internal-transfer-matcher.js";

const MULTI_HOP_WINDOW_SEC = 14 * 24 * 60 * 60;
const MAX_CYCLE_LEGS = 6;

export interface MultiHopCycle {
  readonly originWalletId: string;
  readonly walletPath: readonly string[];
  readonly legs: readonly MatchedCrossChainPair[];
  readonly totalFeeUsd: number;
  readonly durationSec: number;
  readonly families: readonly string[];
}

function pairKey(p: MatchedCrossChainPair): string {
  return `${p.outTxHash}|${p.inTxHash}`;
}

export function detectMultiHopCycles(
  pairs: ReadonlyArray<MatchedCrossChainPair>,
): MultiHopCycle[] {
  if (pairs.length < 2) return [];

  const sorted = [...pairs].sort((a, b) => a.outOpTimeSec - b.outOpTimeSec);
  // Adjacency by outWallet → list of pairs starting from that wallet, sorted by outOpTimeSec.
  const adj = new Map<string, MatchedCrossChainPair[]>();
  for (const p of sorted) {
    const arr = adj.get(p.outWalletId) ?? [];
    arr.push(p);
    adj.set(p.outWalletId, arr);
  }

  const used = new Set<string>();
  const cycles: MultiHopCycle[] = [];

  for (const startPair of sorted) {
    if (used.has(pairKey(startPair))) continue;
    const path = dfsToCycle(
      startPair,
      adj,
      used,
      startPair.outWalletId,
      startPair.outOpTimeSec,
    );
    if (!path) continue;
    for (const p of path) used.add(pairKey(p));
    cycles.push(buildCycle(path));
  }

  return cycles;
}

function dfsToCycle(
  current: MatchedCrossChainPair,
  adj: Map<string, MatchedCrossChainPair[]>,
  used: Set<string>,
  origin: string,
  cycleStart: number,
  visited: ReadonlySet<string> = new Set(),
  path: ReadonlyArray<MatchedCrossChainPair> = [],
): readonly MatchedCrossChainPair[] | null {
  if (used.has(pairKey(current))) return null;
  if (visited.has(pairKey(current))) return null; // avoid infinite loop
  if (path.length >= MAX_CYCLE_LEGS) return null;
  if (current.inOpTimeSec - cycleStart > MULTI_HOP_WINDOW_SEC) return null;

  const nextPath = [...path, current];

  // Если current.inWalletId === origin → cycle закрыт.
  if (current.inWalletId === origin && nextPath.length >= 2) {
    return nextPath;
  }

  const nextVisited = new Set(visited);
  nextVisited.add(pairKey(current));

  // Look for next leg starting from current.inWalletId, after current.inOpTimeSec.
  const candidates = adj.get(current.inWalletId) ?? [];
  for (const next of candidates) {
    if (next.outOpTimeSec < current.inOpTimeSec) continue;
    if (used.has(pairKey(next))) continue;
    if (nextVisited.has(pairKey(next))) continue;
    const result = dfsToCycle(
      next,
      adj,
      used,
      origin,
      cycleStart,
      nextVisited,
      nextPath,
    );
    if (result) return result;
  }
  return null;
}

function buildCycle(path: readonly MatchedCrossChainPair[]): MultiHopCycle {
  const walletPath = [path[0]!.outWalletId, ...path.map((p) => p.inWalletId)];
  const totalFeeUsd = path.reduce((s, p) => s + p.feeUsd, 0);
  const durationSec =
    path[path.length - 1]!.inOpTimeSec - path[0]!.outOpTimeSec;
  const familiesSet = new Set<string>();
  for (const p of path) {
    const f = tokenFamily(p.symbol);
    if (f) familiesSet.add(f);
  }
  return {
    originWalletId: path[0]!.outWalletId,
    walletPath,
    legs: path,
    totalFeeUsd,
    durationSec,
    families: [...familiesSet].sort(),
  };
}
