/**
 * B5 shadow-diff comparator — compares the client's computed positions against
 * the server's shadow `OpenPosition[]` and reports per-position startUsd deltas.
 *
 * Pure & deterministic (no I/O, no Date.now) — the flip criterion ("N refreshes
 * with zero material diffs across the golden anchors") reads `divergentCount`.
 *
 * Positions are matched on a STABLE composite key, NOT the volatile positionId
 * (POS-NNN renumbers across progressive loads). The key mirrors the golden
 * anchor identity: chain | protocolId | lpTokenId | matchedV3TokenId |
 * firstSupplySymbol — the last segment disambiguates decomposed multi-collateral
 * positions that share one receipt (e.g. a Fluid vault → ETH row + WBTC row).
 */
import type { OpenPosition } from "@cap-flow/ucb/open_positions";

export const SHADOW_DIFF_DEFAULT_THRESHOLD_USD = 1;

export type ShadowPositionPresence = "both" | "client_only" | "server_only";

export interface ShadowPositionDelta {
  key: string;
  presence: ShadowPositionPresence;
  clientStartUsd: number | null;
  serverStartUsd: number | null;
  /** client − server; null unless present on both sides. */
  deltaStartUsd: number | null;
  /** `both` AND |delta| > threshold. */
  divergent: boolean;
}

export interface ShadowDiffSummary {
  divergentCount: number;
  matchedCount: number;
  clientOnlyCount: number;
  serverOnlyCount: number;
  thresholdUsd: number;
  /** Sorted by |delta| desc (presence-only entries last), then key asc. */
  deltas: ShadowPositionDelta[];
}

function keyOf(p: OpenPosition): string {
  return [
    p.chain,
    p.protocol?.id ?? "",
    p.lpTokenId ?? "",
    p.matchedV3TokenId ?? "",
    p.supplyTokens?.[0]?.symbol ?? "",
  ].join("|");
}

export function diffShadowPositions(
  client: readonly OpenPosition[],
  server: readonly OpenPosition[],
  opts?: { thresholdUsd?: number },
): ShadowDiffSummary {
  const threshold = opts?.thresholdUsd ?? SHADOW_DIFF_DEFAULT_THRESHOLD_USD;

  const byKey = (positions: readonly OpenPosition[]) => {
    const m = new Map<string, OpenPosition>();
    for (const p of positions) m.set(keyOf(p), p);
    return m;
  };
  const c = byKey(client);
  const s = byKey(server);

  const keys = new Set<string>([...c.keys(), ...s.keys()]);
  const deltas: ShadowPositionDelta[] = [];
  let divergentCount = 0;
  let matchedCount = 0;
  let clientOnlyCount = 0;
  let serverOnlyCount = 0;

  for (const key of keys) {
    const cp = c.get(key);
    const sp = s.get(key);
    if (cp && sp) {
      matchedCount++;
      const deltaStartUsd = cp.startUsd - sp.startUsd;
      const divergent = Math.abs(deltaStartUsd) > threshold;
      if (divergent) divergentCount++;
      deltas.push({
        key,
        presence: "both",
        clientStartUsd: cp.startUsd,
        serverStartUsd: sp.startUsd,
        deltaStartUsd,
        divergent,
      });
    } else if (cp) {
      clientOnlyCount++;
      deltas.push({
        key,
        presence: "client_only",
        clientStartUsd: cp.startUsd,
        serverStartUsd: null,
        deltaStartUsd: null,
        divergent: false,
      });
    } else if (sp) {
      serverOnlyCount++;
      deltas.push({
        key,
        presence: "server_only",
        clientStartUsd: null,
        serverStartUsd: sp.startUsd,
        deltaStartUsd: null,
        divergent: false,
      });
    }
  }

  // |delta| desc; presence-only (null delta) sink to the bottom; ties by key asc.
  deltas.sort((a, b) => {
    const av = a.deltaStartUsd == null ? -1 : Math.abs(a.deltaStartUsd);
    const bv = b.deltaStartUsd == null ? -1 : Math.abs(b.deltaStartUsd);
    if (bv !== av) return bv - av;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  return {
    divergentCount,
    matchedCount,
    clientOnlyCount,
    serverOnlyCount,
    thresholdUsd: threshold,
    deltas,
  };
}
