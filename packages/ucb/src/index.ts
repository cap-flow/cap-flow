/**
 * @cap-flow/ucb — shared UCB cost-basis engine.
 *
 * One source of truth for the lot tracker, position builder, classifier
 * heuristics, and the cost-basis overrides — consumed by BOTH the web client
 * (`apps/web`) and (later, Epic B) the server (`apps/api`), so the two never
 * drift. Modules are moved here WHOLE, preserving each one's private helpers
 * verbatim (e.g. the intentionally-different `normalizeSymbol` copies are NOT
 * unified — see notes/decisions/ucb-server-port-master-plan.md, A0 correction).
 *
 * Extraction is incremental (A0.x slices); web re-exports each moved module
 * from its old `@/lib/portfolio/...` path so import sites stay unchanged.
 */
export * from "./types.js";
export * from "./token_roles.js";
export * from "./wrapped_symbols.js";
export * from "./protocols.js";
export * from "./junk_filter.js";
export * from "./pricing.js";
export * from "./derivation.js";
export * from "./identity.js";
