/**
 * B5 — the /ucb/shadow-diff route's core logic, framework-free + testable.
 *
 * The browser POSTs its own computed positions; we diff them against the latest
 * server shadow for that account, persist the summary onto that shadow row
 * (diff_summary), and return it. The thin Fastify registration (auth, account
 * resolution, body schema) wraps this — see the route attach.
 */
import type { OpenPosition } from "@cap-flow/ucb/open_positions";

import { diffShadowPositions, type ShadowDiffSummary } from "./shadow-diff.js";
import type { UcbShadowRepository } from "./ucb-shadow.repository.js";

export type ShadowDiffOutcome =
  | { status: "no_shadow"; summary: null }
  | {
      status: "compared";
      shadowId: string;
      computedAt: Date;
      summary: ShadowDiffSummary;
    };

export interface ShadowDiffDeps {
  shadowRepo: Pick<
    UcbShadowRepository,
    "findLatestForAccount" | "updateDiffSummary"
  >;
}

/**
 * Compare the client's positions against the account's latest server shadow,
 * persist + return the diff. `no_shadow` when the worker hasn't produced a
 * shadow yet (flag still OFF, or first refresh pending) — the caller surfaces
 * that distinctly from a zero-divergence match.
 */
export async function runShadowDiff(
  deps: ShadowDiffDeps,
  accountId: string,
  clientPositions: readonly OpenPosition[],
  opts?: { thresholdUsd?: number },
): Promise<ShadowDiffOutcome> {
  const latest = await deps.shadowRepo.findLatestForAccount(accountId);
  if (!latest) return { status: "no_shadow", summary: null };

  const summary = diffShadowPositions(clientPositions, latest.positions, opts);
  await deps.shadowRepo.updateDiffSummary(latest.id, summary);

  return {
    status: "compared",
    shadowId: latest.id,
    computedAt: latest.computedAt,
    summary,
  };
}
