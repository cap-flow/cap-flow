/**
 * Перенесено в `@cap-flow/ucb/v3_dedupe_matched` (порт V3-операций в серверный
 * движок, 2026-06-12) — этот файл остаётся тонким re-export'ом, чтобы не плодить
 * параллельные реализации (anti-recurrence #3). Историю/доку см. в пакете.
 */
export {
  dedupeMatchedV3TokenIds,
  type DedupResult,
} from "@cap-flow/ucb/v3_dedupe_matched";
