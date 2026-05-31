/**
 * Moved to `@cap-flow/ucb` (A0 — shared engine extraction). Re-export shim
 * keeps existing `@/lib/portfolio/token_roles` import sites working with zero
 * behaviour change. New code may import from `@cap-flow/ucb` directly.
 */
export * from "@cap-flow/ucb/token_roles";
