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
  /** Net cost basis (collateral − debt); null unless both sides carry it. */
  clientNetStartUsd: number | null;
  serverNetStartUsd: number | null;
  deltaNetStartUsd: number | null;
  /**
   * M5 structural parity — matching startUsd alone is insufficient (the server
   * could reach the same number via a different coverage split, or lack a
   * client-only override). These flag when a material non-numeric field differs
   * WITHIN a matched pair. (matchedV3TokenId is part of the match key, so a V3
   * enrichment gap surfaces as presence client_only/server_only, not here.)
   */
  coverageMismatch: boolean;
  openedAtMismatch: boolean;
  /** The fields that diverged (e.g. ["startUsd","coverageIncomplete"]). */
  reasons: string[];
  /** `both` AND any material field (numeric over threshold OR structural) differs. */
  divergent: boolean;
}

export interface ShadowDiffSummary {
  divergentCount: number;
  matchedCount: number;
  clientOnlyCount: number;
  serverOnlyCount: number;
  /**
   * The flip gate: 0 ⇔ true parity. Aggregates matched-pair divergences AND
   * presence mismatches (a position on one side only is a real divergence — e.g.
   * a server missing V3 enrichment shows as client_only/server_only). The flip
   * criterion is `materialDivergenceCount === 0` across the golden anchors, not
   * just `divergentCount === 0`.
   */
  materialDivergenceCount: number;
  thresholdUsd: number;
  /** Sorted by |delta| desc (presence-only entries last), then key asc. */
  deltas: ShadowPositionDelta[];
}

const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

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
      const cNet = numOrNull(cp.netStartUsd);
      const sNet = numOrNull(sp.netStartUsd);
      const deltaNetStartUsd = cNet != null && sNet != null ? cNet - sNet : null;
      const coverageMismatch =
        (cp.coverageIncomplete ?? false) !== (sp.coverageIncomplete ?? false);
      const openedAtMismatch = (cp.openedAt ?? null) !== (sp.openedAt ?? null);

      const reasons: string[] = [];
      if (Math.abs(deltaStartUsd) > threshold) reasons.push("startUsd");
      if (deltaNetStartUsd != null && Math.abs(deltaNetStartUsd) > threshold)
        reasons.push("netStartUsd");
      if (coverageMismatch) reasons.push("coverageIncomplete");
      if (openedAtMismatch) reasons.push("openedAt");
      const divergent = reasons.length > 0;
      if (divergent) divergentCount++;
      deltas.push({
        key,
        presence: "both",
        clientStartUsd: cp.startUsd,
        serverStartUsd: sp.startUsd,
        deltaStartUsd,
        clientNetStartUsd: cNet,
        serverNetStartUsd: sNet,
        deltaNetStartUsd,
        coverageMismatch,
        openedAtMismatch,
        reasons,
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
        clientNetStartUsd: numOrNull(cp.netStartUsd),
        serverNetStartUsd: null,
        deltaNetStartUsd: null,
        coverageMismatch: false,
        openedAtMismatch: false,
        reasons: ["presence:client_only"],
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
        clientNetStartUsd: null,
        serverNetStartUsd: numOrNull(sp.netStartUsd),
        deltaNetStartUsd: null,
        coverageMismatch: false,
        openedAtMismatch: false,
        reasons: ["presence:server_only"],
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
    materialDivergenceCount: divergentCount + clientOnlyCount + serverOnlyCount,
    thresholdUsd: threshold,
    deltas,
  };
}
