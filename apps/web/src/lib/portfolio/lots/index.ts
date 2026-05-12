/**
 * Public API модуля `lots/`.
 *
 * Используется как `import { LotTracker, buildLotTrackerFromOps } from
 * "@/lib/portfolio/lots"`.
 */

export { LotTracker, createLotTracker } from "./lot_tracker";
export { buildLotTrackerFromOps } from "./build";
export {
  applyTokenMigration,
  applyAllKnownMigrations,
  applyRebaseYield,
  REBASE_TOKENS,
} from "./edge_cases";
export { runLotsSelfCheck } from "./self_check";
export type { TokenMigration } from "./edge_cases";
export type {
  AcquiredVia,
  Lot,
  LotConsumption,
  LotMethodology,
  ConsumeResult,
  AcquireOptions,
  ConsumeOptions,
} from "./types";
