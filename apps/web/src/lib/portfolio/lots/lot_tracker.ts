/**
 * Moved to `@cap-flow/ucb` (A0 — shared engine extraction). Re-export shim
 * keeps existing `@/lib/portfolio/lots/lot_tracker` import sites working with
 * zero behaviour change. Its private `normalizeSymbol` (WETH→ETH only) is
 * preserved verbatim — NOT unified with the other copies.
 */
export * from "@cap-flow/ucb/lots/lot_tracker";
