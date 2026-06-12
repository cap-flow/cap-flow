/**
 * Pipeline observability — именованные этапы серверного UCB-движка.
 *
 * Движок уже линейный конвейер (sources → load → link → ledger → price → build
 * → overrides → verify → publish), но этапы были анонимными блоками кода:
 * статусы нигде не сохранялись, сбои источников глотались молча (Krystal 402 у
 * melody789789 выключил LP-авторитет без единого сигнала), а override-слой мог
 * молча заменить верное значение худшим (аудит 2026-06-11, F2).
 *
 * Этот модуль НЕ меняет расчёт. Он оборачивает существующие шаги:
 *   - каждый шаг получает имя, статус (ok|warn|fail|skipped), длительность,
 *     метрики и человекочитаемые warnings;
 *   - override-шаги дополнительно фиксируют, ЧТО они изменили (per-position
 *     дельты startUsd) — будущая точка для confidence-гейта «прикидка не
 *     затирает факт»;
 *   - запись уходит в ucb_shadow_results.stages (jsonb) рядом с positions.
 *
 * Инвариант: запуск с trace и без trace даёт байт-в-байт одинаковые positions.
 */
import type { OpenPosition } from "@cap-flow/ucb/open_positions";

export type StageStatus = "ok" | "warn" | "fail" | "skipped";

export interface StageRecord {
  stage: string;
  status: StageStatus;
  ms: number;
  metrics?: Record<string, number | string>;
  warnings?: string[];
}

/** Хэндл внутри этапа: копит метрики/предупреждения текущего шага. */
export interface StageHandle {
  metric(key: string, value: number | string): void;
  warn(message: string): void;
}

/** Канонические имена этапов — единый словарь для БД, логов и админ-экрана. */
export const PIPELINE_STAGES = [
  "sources.live",
  "sources.cex",
  "sources.krystal",
  "load.ops",
  "link",
  "ledger",
  "price",
  "build",
  "override.v3",
  "override.lending",
  "override.cex",
  "override.krystal",
  "override.opener",
  "verify.tracker",
] as const;

export class PipelineTrace {
  readonly records: StageRecord[] = [];

  /**
   * Выполнить fn как именованный этап: замер времени, статус ok/warn
   * (warn — если этап добавил warnings), fail при throw (ошибка
   * перебрасывается — fail-soft решает вызывающий, как и раньше).
   */
  async run<T>(
    stage: string,
    fn: (h: StageHandle) => Promise<T> | T,
  ): Promise<T> {
    const metrics: Record<string, number | string> = {};
    const warnings: string[] = [];
    const handle: StageHandle = {
      metric: (k, v) => {
        metrics[k] = v;
      },
      warn: (m) => {
        warnings.push(m);
      },
    };
    const t0 = Date.now();
    try {
      const out = await fn(handle);
      this.records.push({
        stage,
        status: warnings.length > 0 ? "warn" : "ok",
        ms: Date.now() - t0,
        ...(Object.keys(metrics).length > 0 && { metrics }),
        ...(warnings.length > 0 && { warnings }),
      });
      return out;
    } catch (e) {
      warnings.push(e instanceof Error ? e.message : String(e));
      this.records.push({
        stage,
        status: "fail",
        ms: Date.now() - t0,
        ...(Object.keys(metrics).length > 0 && { metrics }),
        warnings,
      });
      throw e;
    }
  }

  /** Этап не выполнялся (нет источника / выключен флагом / нет данных). */
  skip(stage: string, reason?: string): void {
    this.records.push({
      stage,
      status: "skipped",
      ms: 0,
      ...(reason !== undefined && { warnings: [reason] }),
    });
  }
}

/** Сэмпл дельт ограничиваем, чтобы jsonb не разбухал на больших аккаунтах. */
const DELTA_SAMPLE_CAP = 20;

export interface StartUsdDelta {
  key: string;
  from: number | null;
  to: number | null;
}

/** Стабильный ключ позиции для дифф-метрик (instanceId — per-NFT дискриминатор). */
export function positionKey(p: OpenPosition): string {
  const anyP = p as unknown as Record<string, unknown>;
  return (
    (anyP["instanceId"] as string | undefined) ??
    `${p.walletId}|${p.protocol.id}|${(anyP["marketKey"] as string | undefined) ?? ""}`
  );
}

/**
 * Что изменил override-шаг: сколько позиций поменяли startUsd и образцы
 * «с какого значения на какое». Матч по индексу — overrides маппят 1:1,
 * порядок сохраняют; при расхождении длин фиксируем это отдельной метрикой.
 */
export function diffStartUsd(
  before: readonly OpenPosition[],
  after: readonly OpenPosition[],
  h: StageHandle,
): void {
  h.metric("positions", after.length);
  if (before.length !== after.length) {
    h.warn(`position count changed: ${before.length} → ${after.length}`);
    return;
  }
  const deltas: StartUsdDelta[] = [];
  for (let i = 0; i < before.length; i++) {
    const b = before[i]!;
    const a = after[i]!;
    const from = b.startUsd ?? null;
    const to = a.startUsd ?? null;
    if (from === to) continue;
    if (deltas.length < DELTA_SAMPLE_CAP)
      deltas.push({ key: positionKey(a), from, to });
    else break;
  }
  const changed = countChanged(before, after);
  h.metric("changed", changed);
  if (deltas.length > 0)
    h.metric(
      "deltas",
      JSON.stringify(deltas.map((d) => `${d.key}: ${d.from} → ${d.to}`)),
    );
}

function countChanged(
  before: readonly OpenPosition[],
  after: readonly OpenPosition[],
): number {
  let n = 0;
  for (let i = 0; i < before.length; i++) {
    if ((before[i]!.startUsd ?? null) !== (after[i]!.startUsd ?? null)) n++;
  }
  return n;
}
