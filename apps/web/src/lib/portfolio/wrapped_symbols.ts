/**
 * Moved to `@cap-flow/ucb` (A0 — shared engine extraction). This re-export
 * shim keeps existing `@/lib/portfolio/wrapped_symbols` import sites working
 * with zero behaviour change. New code may import from `@cap-flow/ucb` directly.
 */
export * from "@cap-flow/ucb/wrapped_symbols";
