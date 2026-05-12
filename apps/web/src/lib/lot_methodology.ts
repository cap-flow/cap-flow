/**
 * Глобальный setting для lot consume методологии (FIFO/LIFO/WAC).
 * Используется в `applyLendingCostBasisOverride` для расчёта Стартовой $
 * lending позиций и как дефолт в `PurchaseHistoryPopup` toggle.
 */

import { useLocalStorage } from "./useLocalStorage";
import type { LotMethodology } from "./portfolio/lots/types";

const KEY = "capflow.lot_methodology";

export function useLotMethodology(): readonly [
  LotMethodology,
  (m: LotMethodology) => void,
] {
  const [m, setM] = useLocalStorage<LotMethodology>(KEY, "FIFO");
  return [m, setM] as const;
}
