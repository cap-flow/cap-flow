/**
 * Helius transaction-feed surface — slice ported from
 * `apps/web/src/lib/helius.ts` (P5.4). Only the shapes the Solana
 * classifier consumes. Network client lives in
 * `apps/api/src/modules/integrations/helius.ts`.
 */

export interface HeliusNativeTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  amount: number; // lamports
}

export interface HeliusTokenTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  fromTokenAccount?: string;
  toTokenAccount?: string;
  tokenAmount: number;
  mint: string;
}

export interface HeliusInstruction {
  programId: string;
  data?: string;
  accounts?: string[];
}

export interface HeliusTransaction {
  description?: string;
  type: string;
  source: string;
  fee: number;
  feePayer: string;
  signature: string;
  slot: number;
  timestamp: number;
  nativeTransfers?: HeliusNativeTransfer[];
  tokenTransfers?: HeliusTokenTransfer[];
  instructions?: HeliusInstruction[];
  events?: {
    swap?: unknown;
    nft?: unknown;
  };
  transactionError?: { error: string } | null;
}
