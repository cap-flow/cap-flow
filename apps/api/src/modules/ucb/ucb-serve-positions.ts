/**
 * B6 — serving decision for server-computed canonical positions.
 *
 * Pure core of `GET /accounts/:id/ucb/positions`. Given the per-user flag, the
 * latest server shadow result, and the latest portfolio snapshot time, decides
 * whether the client may adopt the server-computed positions or must fall back
 * to its own recompute. The client keeps the recompute path as a PERMANENT
 * fallback (risk R16) — this only tells it whether a trustworthy server result
 * exists.
 *
 * "Fresh" = the shadow was computed no earlier than the latest snapshot, i.e.
 * the server engine has seen at least as recent a live state as the dashboard.
 * A snapshot newer than the shadow means a refresh ran without recomputing the
 * shadow (e.g. the compute flag was off that cycle) → the served positions would
 * be stale, so we fall back.
 */
import type { OpenPosition } from "@cap-flow/ucb/open_positions";

import type { UcbShadowResult } from "./ucb-shadow.repository.js";

export type ServeReason =
  | "served"
  | "flag_off"
  | "no_shadow"
  | "shadow_error"
  | "stale";

export interface ServeDecisionInput {
  /** `capflow.feature.ucbServerCanonical` resolved for this user (default OFF). */
  flagEnabled: boolean;
  /** Latest `ucb_shadow_results` row for the account, or null if none. */
  shadow: UcbShadowResult | null;
  /** `createdAt` of the account's latest portfolio snapshot, or null. */
  latestSnapshotAt: Date | null;
}

export interface ServeDecision {
  /** True → the client may adopt `positions`; false → recompute client-side. */
  serve: boolean;
  reason: ServeReason;
  positions: OpenPosition[] | null;
  computedAt: string | null;
  engineVersion: string | null;
  lotMethodology: string | null;
}

const notServed = (reason: ServeReason): ServeDecision => ({
  serve: false,
  reason,
  positions: null,
  computedAt: null,
  engineVersion: null,
  lotMethodology: null,
});

export function decideServePositions(input: ServeDecisionInput): ServeDecision {
  if (!input.flagEnabled) return notServed("flag_off");
  const s = input.shadow;
  if (!s) return notServed("no_shadow");
  if (s.error) return notServed("shadow_error");
  if (
    input.latestSnapshotAt &&
    s.computedAt.getTime() < input.latestSnapshotAt.getTime()
  ) {
    return notServed("stale");
  }
  return {
    serve: true,
    reason: "served",
    positions: s.positions,
    computedAt: s.computedAt.toISOString(),
    engineVersion: s.engineVersion,
    lotMethodology: s.lotMethodology,
  };
}
