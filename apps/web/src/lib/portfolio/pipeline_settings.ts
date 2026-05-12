/**
 * Настройки pipeline'а сборки портфеля.
 *
 * Live-first vs history-first — фундаментальный архитектурный выбор.
 *
 *  - **history-first** (legacy): сначала классифицируется ВСЯ история операций,
 *    строится snapshot, выводятся inferred-позиции из ops без парных
 *    закрытий. Live-данные накладываются сверху. Минусы: фантомные позиции
 *    когда classifier не распознал withdraw, двойной учёт receipt-токенов,
 *    расхождения между источниками истины.
 *
 *  - **live-first** (рекомендованный): live snapshot — единственная точка
 *    истины «что у меня сейчас». История анализируется только для тех
 *    позиций / токенов, что ЕСТЬ в live (cost basis, age, claim_rewards).
 *    Inferred-позиции отключены — закрытые on-chain исчезают сами.
 *
 * Хранится в localStorage отдельным ключом, чтобы не тащить в основные
 * settings пока feature эксперимент.
 */

import { useLocalStorage } from "@/lib/useLocalStorage";

export interface PipelineSettings {
  /**
   * Live-first pipeline. На текущем уровне развития CapFlow всегда true:
   * inferred-позиции в OpenPositions не строятся, всё что не в live идёт
   * в архив через `buildClosedPositions`.
   * Поле сохранено для совместимости с старым localStorage.
   */
  useLiveFirst: boolean;
  /**
   * Показывать ли в архиве unmatched-циклы (open в истории без матча
   * close, при этом live API позицию не возвращает). Это предположительно
   * закрытые позиции, для которых classifier не распознал withdraw.
   * По умолчанию **true** — пользователю важно видеть всю историю.
   */
  inferredFallback: boolean;
}

const DEFAULT: PipelineSettings = {
  useLiveFirst: true,
  inferredFallback: true,
};

const KEY = "capflow.pipeline_settings";

export function usePipelineSettings() {
  return useLocalStorage<PipelineSettings>(KEY, DEFAULT);
}

/**
 * Не-React getter для случаев когда нужно прочитать настройку из чистой
 * функции (например, `buildOpenPositions`).
 */
export function readPipelineSettings(): PipelineSettings {
  if (typeof window === "undefined") return DEFAULT;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT;
    const parsed = JSON.parse(raw) as Partial<PipelineSettings>;
    return { ...DEFAULT, ...parsed };
  } catch {
    return DEFAULT;
  }
}
