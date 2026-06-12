/**
 * Перенесено в `@cap-flow/ucb/krystal/phantom_filter` (порт V3-операций в
 * серверный движок, 2026-06-12) — этот файл остаётся тонким re-export'ом,
 * чтобы не плодить параллельные реализации. Историю/доку см. в пакете.
 */
export {
  KRYSTAL_COVERED_CHAINS,
  buildKrystalOpenIndex,
  filterKrystalAbsentV3Phantoms,
  type KrystalOpenIndex,
  type PhantomFilterResult,
} from "@cap-flow/ucb/krystal/phantom_filter";
