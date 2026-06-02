/**
 * Re-export shim — the non-LP opener override now lives in `@cap-flow/ucb`
 * (B4 slice 1) so the server can apply it too. Import sites unchanged.
 */
export {
  applyNonLpOpenerOverride,
  type OpenerOverrideResult,
} from "@cap-flow/ucb/apply_opener_override";
