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
import type { NonLpOpener } from "../../nonlp/opener_detector";
import type { V3PositionMap } from "../../v3/hook";
import type { V3Position } from "../../v3/positions";
import type { V3CostBasisResult } from "../../v3/liquidity_events";
import type {
  KrystalV3Summary,
  KrystalTransactionsSummary,
} from "../../krystal/adapter";
import type { ResolvedAnnotation } from "@/features/chain-ops/api";

/**
 * V3 inputs carry `bigint` fields (tokenId/liquidity/amounts) which JSON can't
 * hold. `tagBigints` rewrites every bigint as `{$bigint:"…"}` (JSON-safe);
 * `reviveBigints` restores them. Generic — no need to enumerate bigint fields.
 */
export function tagBigints(v: unknown): unknown {
  if (typeof v === "bigint") return { $bigint: v.toString() };
  if (Array.isArray(v)) return v.map(tagBigints);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = tagBigints(val);
    return out;
  }
  return v;
}
export function reviveBigints(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reviveBigints);
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === "$bigint") {
      return BigInt((v as { $bigint: string }).$bigint);
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = reviveBigints(val);
    return out;
  }
  return v;
}

/** Durable on-chain anchor used to locate the position in replay output. */
export interface GoldenAnchor {
  chain: string;
  protocolId: string;
  /** V3/Velodrome NFT tokenId, lending receipt addr, or null (e.g. CEX). */
  marketKey: string | null;
  openHash: string | null;
  /** Matched V3/V4/CL NFT tokenId — disambiguates multiple NFTs in one pool. */
  tokenId?: string | null;
}

export type AnchorMatchKey = "protocolId" | "marketKey" | "openHash" | "tokenId";

export interface GoldenExpected {
  startUsd?: number;
  netStartUsd?: number;
  currentUsd?: number;
  pnlUsd?: number;
  /** Pass = within abs OR pct (whichever is looser). Defaults: $1 / 2%. */
  toleranceAbsUsd?: number;
  tolerancePct?: number;
}

/** One asserted position inside a multi-anchor fixture. */
export interface GoldenAssertion {
  label: string;
  anchor: GoldenAnchor;
  match: AnchorMatchKey;
  expected: GoldenExpected;
  /** Optional honesty marker, e.g. "engineTraced=false; spot-fallback priced". */
  caveat?: string;
}

export interface GoldenFixture {
  schemaVersion: number;
  label: string;
  methodologyVersion: string;
  lotMethodology?: LotMethodology;
  position: { anchor: GoldenAnchor; match: AnchorMatchKey };
  /**
   * Multi-anchor: a single wallet capture commonly proves several golden
   * positions at once (one testakk wallet → many marked anchors). When present,
   * the regression harness asserts every entry here; `position`/`expected` stay
   * as the primary/first anchor for backward compatibility with single-anchor
   * fixtures. Absent → single-anchor fixture.
   */
  anchors?: GoldenAssertion[];
  input: {
    wallets: ReplayWalletInput[];
    histPrices?: [string, number][];
    v3LpHistPrices?: [string, number][];
    cexCostBasisByHash?: [string, CexCostBasisMatch][];
    annotationsByKey?: [string, ResolvedAnnotation][];
    resolvedAnnotations?: ResolvedAnnotation[];
    costBasisOverrideByHash?: [string, number][];
    nonLpOpenerByKey?: [string, NonLpOpener][];
    /** Tagged-bigint V3 NFT positions (Map<walletId, V3Position[]>). */
    v3PositionMap?: [string, unknown[]][];
    /** Tagged-bigint V3 cost-basis results (Map<`chain|tokenId`, V3CostBasisResult>). */
    v3CostBasis?: [string, unknown][];
    /** Krystal V3 summaries by tokenId (authoritative LP startUsd). */
    krystalV3ByTokenId?: [string, KrystalV3Summary][];
    /** Krystal per-NFT transactions by tokenId. */
    krystalTxByTokenId?: [string, KrystalTransactionsSummary][];
  };
  expected: GoldenExpected;
  provenance: { sourceOfTruth: string; note: string };
}

/**
 * Serialize a live `ReplayInput` (Maps + runtime objects) into a committable
 * `GoldenFixture` — the inverse of `fixtureToReplayInput`. Maps become
 * `[key, value][]` arrays so the result is plain JSON. Used by the A3.2
 * fixture-export path (capture a marked position's exact pipeline inputs →
 * freeze → offline regression). Round-trips: `fixtureToReplayInput(
 * replayInputToFixture(x)) ≈ x` and `replayInputToFixture(fixtureToReplayInput(
 * f)) ≈ f`.
 */
export function replayInputToFixture(args: {
  label: string;
  methodologyVersion: string;
  input: ReplayInput;
  anchor: GoldenAnchor;
  match: AnchorMatchKey;
  expected: GoldenExpected;
  provenance: { sourceOfTruth: string; note: string };
  schemaVersion?: number;
}): GoldenFixture {
  const { input } = args;
  const fixtureInput: GoldenFixture["input"] = {
    wallets: input.wallets.map((w) => ({
      wallet: w.wallet,
      ops: w.ops,
      ...(w.live !== undefined && { live: w.live }),
    })),
  };
  if (input.histPrices)
    fixtureInput.histPrices = Array.from(input.histPrices.entries());
  if (input.v3LpHistPrices)
    fixtureInput.v3LpHistPrices = Array.from(input.v3LpHistPrices.entries());
  if (input.cexCostBasisByHash)
    fixtureInput.cexCostBasisByHash = Array.from(
      input.cexCostBasisByHash.entries(),
    );
  if (input.annotationsByKey)
    fixtureInput.annotationsByKey = Array.from(
      input.annotationsByKey.entries(),
    );
  if (input.resolvedAnnotations)
    fixtureInput.resolvedAnnotations = [...input.resolvedAnnotations];
  if (input.costBasisOverrideByHash)
    fixtureInput.costBasisOverrideByHash = Array.from(
      input.costBasisOverrideByHash.entries(),
    );
  if (input.nonLpOpenerByKey)
    fixtureInput.nonLpOpenerByKey = Array.from(
      input.nonLpOpenerByKey.entries(),
    );
  if (input.v3PositionMap)
    fixtureInput.v3PositionMap = Array.from(input.v3PositionMap.entries()).map(
      ([k, v]) => [k, tagBigints(v) as unknown[]],
    );
  if (input.v3CostBasis)
    fixtureInput.v3CostBasis = Array.from(input.v3CostBasis.entries()).map(
      ([k, v]) => [k, tagBigints(v)],
    );
  if (input.krystalV3ByTokenId)
    fixtureInput.krystalV3ByTokenId = Array.from(
      input.krystalV3ByTokenId.entries(),
    );
  if (input.krystalTxByTokenId)
    fixtureInput.krystalTxByTokenId = Array.from(
      input.krystalTxByTokenId.entries(),
    );
  return {
    schemaVersion: args.schemaVersion ?? 1,
    label: args.label,
    methodologyVersion: args.methodologyVersion,
    ...(input.lotMethodology !== undefined && {
      lotMethodology: input.lotMethodology,
    }),
    position: { anchor: args.anchor, match: args.match },
    input: fixtureInput,
    expected: args.expected,
    provenance: args.provenance,
  };
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
  if (f.input.nonLpOpenerByKey)
    out.nonLpOpenerByKey = new Map(f.input.nonLpOpenerByKey);
  if (f.input.v3PositionMap)
    out.v3PositionMap = new Map(
      f.input.v3PositionMap.map(([k, v]) => [
        k,
        reviveBigints(v) as V3Position[],
      ]),
    ) as V3PositionMap;
  if (f.input.v3CostBasis)
    out.v3CostBasis = new Map(
      f.input.v3CostBasis.map(([k, v]) => [
        k,
        reviveBigints(v) as V3CostBasisResult,
      ]),
    );
  if (f.input.krystalV3ByTokenId)
    out.krystalV3ByTokenId = new Map(f.input.krystalV3ByTokenId);
  if (f.input.krystalTxByTokenId)
    out.krystalTxByTokenId = new Map(f.input.krystalTxByTokenId);
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
    case "tokenId":
      return anchor.tokenId != null && p.matchedV3TokenId === anchor.tokenId;
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
