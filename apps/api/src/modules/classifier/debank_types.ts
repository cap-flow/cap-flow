/**
 * DeBank API surface types — slice ported from
 * `apps/web/src/lib/debank.ts` (P5.3). Only the request/response shapes
 * the classifier consumes live here. Network client lives in
 * `apps/api/src/modules/integrations/` (separate concern).
 */

export interface DeBankToken {
  id: string;
  chain: string;
  name: string;
  symbol: string;
  decimals: number;
  logo_url: string | null;
  price?: number;
}

export interface DeBankProject {
  id: string;
  chain: string;
  name: string;
  logo_url: string | null;
  site_url?: string;
}

export interface DeBankSendOrReceive {
  amount: number;
  to_addr?: string;
  from_addr?: string;
  token_id: string;
}

export interface DeBankTokenApprove {
  spender: string;
  token_id: string;
  value: number;
}

export interface DeBankTx {
  from_addr: string;
  to_addr: string;
  value?: number;
  eth_gas_fee?: number;
  usd_gas_fee?: number;
  status?: number; // 1 — success, 0 — failed
  name?: string;
  params?: unknown[];
}

export interface DeBankHistoryItem {
  id: string;
  chain: string;
  cate_id: string | null;
  time_at: number;
  project_id: string | null;
  cex_id: string | null;
  sends: DeBankSendOrReceive[];
  receives: DeBankSendOrReceive[];
  token_approve: DeBankTokenApprove | null;
  tx: DeBankTx | null;
}
