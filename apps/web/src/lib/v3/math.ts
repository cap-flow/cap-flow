/**
 * V3 tick ↔ price math moved to @cap-flow/ucb/v3_math (B3-full layer 2a) so the
 * client + the server compute amounts/prices identically; re-exported here for
 * existing import sites.
 */
export * from "@cap-flow/ucb/v3_math";
