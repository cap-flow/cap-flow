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

import { useAuth } from "@/features/auth/AuthProvider";

import { api } from "./api/client";
import { useLocalStorage } from "./useLocalStorage";
import type { LotMethodology } from "./portfolio/lots/types";

const KEY = "capflow.lot_methodology";
const schema = z.object({ methodology: z.enum(["FIFO", "LIFO", "WAC", "HIFO"]) });

// Module-level guard: трекаем, для КАКОГО пользователя уже гидрировали методику
// с сервера. Раньше это был булев `hydrated` (once-per-session) — и он НЕ
// сбрасывался при impersonation: админ гидрировал свой FIFO первым, затем
// заходил под melody (saved=LIFO), но повторной гидрации не было → toggle
// оставался FIFO → серверный (LIFO) результат отвергался guard'ом методики и
// браузер тихо пересчитывал свои числа (аудит melody789789, 2026-06-12).
// Теперь гидрация повторяется при смене текущего пользователя (вход/impersonation).
let hydratedForUserId: string | null = null;

export function useLotMethodology(): readonly [
  LotMethodology,
  (m: LotMethodology) => void,
] {
  const [m, setLocal] = useLocalStorage<LotMethodology>(KEY, "FIFO");
  const { user } = useAuth();
  const userId = user?.id ?? null;

  // Гидрация с сервера (cross-device + impersonation source of truth). Повторно
  // тянет при смене userId. setLocal распространяет значение на все смонтированные
  // инстансы хука через storage-событие в той же вкладке.
  useEffect(() => {
    if (!userId) return;
    if (hydratedForUserId === userId) return;
    hydratedForUserId = userId;
    api
      .get("/v1/me/lot-methodology", schema)
      .then((r) => setLocal(r.methodology))
      .catch(() => {
        // unauthenticated / transient — оставляем localStorage; разрешаем ретрай
        // при следующем рендере (не залипаем на неудачной гидрации).
        if (hydratedForUserId === userId) hydratedForUserId = null;
      });
  }, [setLocal, userId]);

  const isViewImpersonation = user?.impersonation?.mode === "view";
  const setM = useCallback(
    (val: LotMethodology) => {
      setLocal(val); // instant UX
      // View-mode impersonation = read-only: НЕ перезаписываем сохранённую
      // методику юзера (инцидент melody789789 2026-06-12: тогл под
      // impersonation увёл WAC→FIFO). Сервер дублирует запрет 403-ом.
      if (isViewImpersonation) return;
      api.put("/v1/me/lot-methodology", { methodology: val }, schema).catch(() => {
        /* persisted best-effort; localStorage already updated */
      });
    },
    [setLocal, isViewImpersonation],
  );

  return [m, setM] as const;
}
