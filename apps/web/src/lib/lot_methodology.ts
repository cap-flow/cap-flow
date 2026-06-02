/**
 * Глобальный setting для lot consume методологии (FIFO/LIFO/WAC/HIFO).
 * Используется в `applyLendingCostBasisOverride` для расчёта Стартовой $
 * lending позиций и как дефолт в `PurchaseHistoryPopup` toggle.
 *
 * Персистится server-side (`users.lot_methodology` via `/v1/me/lot-methodology`)
 * — чтобы серверный shadow-расчёт следовал выбору юзера (совпадал с его UI) и
 * чтобы выбор переносился между устройствами. localStorage остаётся для мгновенного
 * UX + offline; сервер = источник истины (гидрация при загрузке).
 */
import { useCallback, useEffect } from "react";
import { z } from "zod";

import { api } from "./api/client";
import { useLocalStorage } from "./useLocalStorage";
import type { LotMethodology } from "./portfolio/lots/types";

const KEY = "capflow.lot_methodology";
const schema = z.object({ methodology: z.enum(["FIFO", "LIFO", "WAC", "HIFO"]) });

// Module-level guard: pull the server value once per session (the hook mounts in
// many places — PurchaseHistoryPopup, lending override — but should GET once).
let hydrated = false;

export function useLotMethodology(): readonly [
  LotMethodology,
  (m: LotMethodology) => void,
] {
  const [m, setLocal] = useLocalStorage<LotMethodology>(KEY, "FIFO");

  // One-time hydration from the server (cross-device source of truth). setLocal
  // propagates to all mounted hook instances via the in-tab storage event.
  useEffect(() => {
    if (hydrated) return;
    hydrated = true;
    api
      .get("/v1/me/lot-methodology", schema)
      .then((r) => setLocal(r.methodology))
      .catch(() => {
        /* unauthenticated / transient — keep localStorage value */
      });
  }, [setLocal]);

  const setM = useCallback(
    (val: LotMethodology) => {
      setLocal(val); // instant UX
      api.put("/v1/me/lot-methodology", { methodology: val }, schema).catch(() => {
        /* persisted best-effort; localStorage already updated */
      });
    },
    [setLocal],
  );

  return [m, setM] as const;
}
