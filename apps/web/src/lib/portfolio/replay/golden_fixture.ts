/**
 * Golden fixture format + loader for the offline replay harness (A2).
 *
 * A golden fixture is a FROZEN, committed snapshot of everything the canonical
 * pipeline consumed for one position (ops + live + prices + annotations), plus
 * the EXPECTED output (startUsd / currentUsd / …) with a tolerance. It is the
 * regression oracle: any future engine change replays every fixture and must
 * stay within tolerance.
 *
 * JSON cannot hold Maps, so map-typed inputs are stored as `[key, value][]`
 * arrays and rehydrated by `fixtureToReplayInput`.
 *
 * Authoring/persistence ritual: notes/decisions/ucb-server-port-master-plan.md
 * ("Golden case authoring & methodology-memory process").
 */
import type { ReplayInput, ReplayWalletInput } from "./replay_positions";
import type { OpenPosition } from "../open_positions";
import type { CexCostBasisMatch } from "../position_coverage";
import type { LotMethodology } from "../lots/types";
import type { ResolvedAnnotation } from "@/features/chain-ops/api";

/** Durable on-chain anchor used to locate the position in replay output. */
export interface GoldenAnchor {
  chain: string;
  protocolId: string;
  /** V3/Velodrome NFT tokenId, lending receipt addr, or null (e.g. CEX). */
  marketKey: string | null;
  openHash: string | null;
}

export type AnchorMatchKey = "protocolId" | "marketKey" | "openHash";

export interface GoldenExpected {
  startUsd?: number;
  netStartUsd?: number;
  currentUsd?: number;
  pnlUsd?: number;
  /** Pass = within abs OR pct (whichever is looser). Defaults: $1 / 2%. */
  toleranceAbsUsd?: number;
  tolerancePct?: number;
}

export interface GoldenFixture {
  schemaVersion: number;
  label: string;
  methodologyVersion: string;
  lotMethodology?: LotMethodology;
  position: { anchor: GoldenAnchor; match: AnchorMatchKey };
  input: {
    wallets: ReplayWalletInput[];
    histPrices?: [string, number][];
    v3LpHistPrices?: [string, number][];
    cexCostBasisByHash?: [string, CexCostBasisMatch][];
    annotationsByKey?: [string, ResolvedAnnotation][];
    resolvedAnnotations?: ResolvedAnnotation[];
    costBasisOverrideByHash?: [string, number][];
  };
  expected: GoldenExpected;
  provenance: { sourceOfTruth: string; note: string };
}

/** Rehydrate a fixture's array-encoded maps into a runtime ReplayInput. */
export function fixtureToReplayInput(f: GoldenFixture): ReplayInput {
  const out: ReplayInput = {
    wallets: f.input.wallets,
    ...(f.lotMethodology !== undefined && { lotMethodology: f.lotMethodology }),
  };
  if (f.input.histPrices) out.histPrices = new Map(f.input.histPrices);
  if (f.input.v3LpHistPrices)
    out.v3LpHistPrices = new Map(f.input.v3LpHistPrices);
  if (f.input.cexCostBasisByHash)
    out.cexCostBasisByHash = new Map(f.input.cexCostBasisByHash);
  if (f.input.annotationsByKey)
    out.annotationsByKey = new Map(f.input.annotationsByKey);
  if (f.input.resolvedAnnotations)
    out.resolvedAnnotations = f.input.resolvedAnnotations;
  if (f.input.costBasisOverrideByHash)
    out.costBasisOverrideByHash = new Map(f.input.costBasisOverrideByHash);
  return out;
}

/**
 * Locate the position a fixture describes, by its durable anchor. Matching on
 * the anchor (not positionId) means cases survive positionId format changes.
 */
export function matchesAnchor(
  p: OpenPosition,
  anchor: GoldenAnchor,
  match: AnchorMatchKey,
): boolean {
  if (p.chain !== anchor.chain) return false;
  switch (match) {
    case "protocolId":
      return p.protocol.id === anchor.protocolId;
    case "marketKey":
      return anchor.marketKey != null && p.lpTokenId === anchor.marketKey;
    case "openHash":
      return anchor.openHash != null && p.openHash === anchor.openHash;
  }
}

export function findGoldenPosition(
  positions: readonly OpenPosition[],
  f: GoldenFixture,
): OpenPosition | undefined {
  return positions.find((p) =>
    matchesAnchor(p, f.position.anchor, f.position.match),
  );
}

/** True when |actual − expected| is within the absolute OR pct band. */
export function withinTolerance(
  actual: number,
  expected: number,
  absTol = 1,
  pctTol = 0.02,
): boolean {
  const absDiff = Math.abs(actual - expected);
  if (absDiff <= absTol) return true;
  if (expected === 0) return false;
  return absDiff / Math.abs(expected) <= pctTol;
}
