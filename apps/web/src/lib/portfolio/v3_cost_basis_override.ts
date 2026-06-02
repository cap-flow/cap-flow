/**
 * Web shim — the pure `applyV3CostBasisOverride` moved to
 * `@cap-flow/ucb/v3_cost_basis_override` (B3-full layer 1) so the server can
 * apply the same V3 cost-basis override. The only client-specific dependency is
 * the viem-backed deployment config (`@/lib/v3/chains`), injected here as
 * `resolveDeploymentIds`; the package stays viem-free.
 *
 * The 3-arg signature is preserved for existing call sites (useComputedPositions,
 * replay_positions, the test).
 */
import { findV3Deployments } from "@/lib/v3/chains";
import {
  applyV3CostBasisOverride as applyV3CostBasisOverrideCore,
  type OverrideResult,
} from "@cap-flow/ucb/v3_cost_basis_override";
import type { V3CostBasisResult, V3Position, V3PositionMap } from "@cap-flow/ucb/v3_types";
import type { OpenPosition } from "./open_positions";

export function applyV3CostBasisOverride(
  positions: readonly OpenPosition[],
  v3PositionMap: V3PositionMap,
  v3CostBasis: Map<string, V3CostBasisResult>,
): OverrideResult {
  return applyV3CostBasisOverrideCore(
    positions,
    v3PositionMap,
    v3CostBasis,
    (chain, protocolName) =>
      findV3Deployments(chain, protocolName).map((d) => d.id),
  );
}

export type { V3CostBasisResult, V3Position, V3PositionMap };
