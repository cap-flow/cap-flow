/**
 * Перенесено в `@cap-flow/ucb/v3_claimed_fees_split` (порт V3-операций в
 * серверный движок, 2026-06-12). Ядро в пакете принимает резолвер деплойментов
 * (как applyV3CostBasisOverride); этот файл — клиентская обёртка с прежней
 * сигнатурой поверх web-каталога `findV3Deployments`.
 */
import {
  applyV3ClaimedFeesSplit as applyCore,
} from "@cap-flow/ucb/v3_claimed_fees_split";
import type { V3CostBasisResult } from "@/lib/v3/liquidity_events";
import type { V3PositionMap } from "@/lib/v3/hook";
import type { OpenPosition } from "./open_positions";
import { findV3Deployments } from "@/lib/v3/chains";

export function applyV3ClaimedFeesSplit(
  positions: readonly OpenPosition[],
  v3PositionMap: V3PositionMap,
  v3CostBasis: ReadonlyMap<string, V3CostBasisResult>,
): OpenPosition[] {
  return applyCore(positions, v3PositionMap, v3CostBasis, (chain, name) =>
    findV3Deployments(chain, name).map((d) => d.id),
  );
}
