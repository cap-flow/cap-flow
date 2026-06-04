/**
 * Classifier types — slice ported from
 * `apps/web/src/lib/portfolio/types.ts` (P5.1). Only the surfaces consumed
 * by `protocols.ts` and `junk_filter.ts` live here. As Phase 5 grows
 * (P5.3+ classifier core, P5.5 LP attribution) this file will be extended
 * with the rest of the contract.
 */

export type OpType =
  | "deposit_fiat"
  | "withdraw_fiat"
  | "transfer_in"
  | "transfer_out"
  | "swap"
  | "lend_supply"
  | "lend_withdraw"
  | "borrow"
  | "repay"
  | "lp_add"
  | "lp_remove"
  | "stake"
  | "unstake"
  | "claim_rewards"
  | "perp_open"
  | "perp_close"
  | "bridge_in"
  | "bridge_out"
  | "approve"
  | "failed"
  | "gas_topup"
  | "noise" // value-less state-only вызов (points/referral/spam/zero-value transfer/EIP-7702) — $0, инертно
  | "unknown";

export type ProtocolCategory =
  | "lending"
  | "dex"
  | "lp"
  | "staking"
  | "restaking"
  | "yield"
  | "perp"
  | "bridge"
  | "cdp"
  | "other";

export interface ProtocolInfo {
  id: string;
  name: string;
  category: ProtocolCategory;
}

export interface TokenMovement {
  direction: "in" | "out";
  symbol: string;
  tokenId: string;
  amount: number;
  usd: number | null;
  isStable: boolean;
  isProtocolToken: boolean;
}

export interface ClassifiedOp {
  seq: number;
  hash: string;
  chain: string;
  time: number;
  status: "ok" | "failed";
  type: OpType;
  protocol: ProtocolInfo | null;
  movement: TokenMovement[];
  netUsd: number;
  gasUsd: number | null;
  counterparty: string | null;
  feePayer: string | null;
  fnName: string | null;
  approveSpender: string | null;
  approveSymbol: string | null;
  notes?: string[];
  detection?: "explicit" | "auto";
  linkedHash?: string;
  linkedLpTokenId?: string;
  linkedLpSymbol?: string;
  linkedCostBasisUsd?: number;
}
