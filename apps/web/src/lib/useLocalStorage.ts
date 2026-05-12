import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Типизированный хук поверх localStorage.
 *
 * Ключевые свойства:
 *   - **Synchronous write** в сеттере: localStorage.setItem вызывается
 *     прямо из set(...), не дожидаясь useEffect. Это критично для случаев,
 *     когда компонент размонтируется сразу после сохранения (диалоги),
 *     иначе useEffect не успевает выстрелить и запись теряется.
 *   - Синхронизация **между вкладками** — через нативное событие `storage`.
 *   - Синхронизация **внутри вкладки** — через custom event
 *     `capflow:storage`. Без него разные компоненты с одним и тем же ключом
 *     не видят изменений друг друга.
 *   - **No-op write**: если контент не изменился, в LS не пишем и event
 *     не диспатчим — защита от бесконечных циклов между двумя экземплярами
 *     хука.
 */

const SAME_TAB_EVENT = "capflow:storage";

interface SameTabEventDetail {
  key: string;
}

export function useLocalStorage<T>(
  key: string,
  initial: T,
): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return initial;
    try {
      const raw = window.localStorage.getItem(key);
      return raw == null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });

  // Сохраняем актуальный value в ref, чтобы set мог считать prev без замыкания.
  const valueRef = useRef(value);
  valueRef.current = value;

  // СИНХРОННАЯ запись из сеттера. Не ждём useEffect — иначе при размонтировании
  // компонента сразу после save запись может быть потеряна.
  const set = useCallback(
    (v: T | ((prev: T) => T)) => {
      let prev = valueRef.current;
      try {
        const raw = window.localStorage.getItem(key);
        if (raw != null) prev = JSON.parse(raw) as T;
      } catch {
        /* ignore — fallback на valueRef */
      }
      const next = typeof v === "function" ? (v as (p: T) => T)(prev) : v;
      try {
        const json = JSON.stringify(next);
        const existing = window.localStorage.getItem(key);
        if (existing !== json) {
          window.localStorage.setItem(key, json);
          window.dispatchEvent(
            new CustomEvent<SameTabEventDetail>(SAME_TAB_EVENT, {
              detail: { key },
            }),
          );
        }
      } catch {
        /* quota / private mode — игнорируем, в state всё равно положим */
      }
      setValue(next);
    },
    [key],
  );

  // Подписка на изменения этого ключа — и кросс-табные, и in-tab.
  useEffect(() => {
    const reread = () => {
      try {
        const raw = window.localStorage.getItem(key);
        if (raw == null) return;
        const next = JSON.parse(raw) as T;
        setValue((prev) => {
          // No-op если контент не изменился — иначе бесконечные ре-рендеры.
          try {
            if (JSON.stringify(prev) === raw) return prev;
          } catch {
            /* fallback ниже */
          }
          return next;
        });
      } catch {
        /* ignore */
      }
    };

    const onStorage = (e: StorageEvent) => {
      if (e.key !== key) return;
      reread();
    };

    const onSameTab = (e: Event) => {
      const ce = e as CustomEvent<SameTabEventDetail>;
      if (!ce.detail || ce.detail.key !== key) return;
      reread();
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener(SAME_TAB_EVENT, onSameTab);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(SAME_TAB_EVENT, onSameTab);
    };
  }, [key]);

  return [value, set];
}
