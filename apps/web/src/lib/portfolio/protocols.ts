/**
 * Moved to `@cap-flow/ucb` (A0 — shared engine extraction). Re-export shim
 * keeps existing `@/lib/portfolio/protocols` import sites working with zero
 * behaviour change. The DefiLlama-catalog fallback is injected via
 * `registerProtocolCatalogOracle` (wired in `main.tsx`).
 */
export * from "@cap-flow/ucb/protocols";
