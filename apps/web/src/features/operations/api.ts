import { z } from "zod";

import { api } from "@/lib/api/client";

export const opTypeSchema = z.enum([
  "buy",
  "sell",
  "swap",
  "transfer",
  "deposit",
  "withdraw",
  "fee",
  "open",
  "close",
  "loan",
  "loan_repay",
  "loan_take",
  "div",
  "other",
]);
export type OpType = z.infer<typeof opTypeSchema>;

export const opSourceSchema = z.enum(["manual", "import", "promoted"]);
export type OpSource = z.infer<typeof opSourceSchema>;

export const fundsKindSchema = z.enum(["own", "loan"]);
export type FundsKind = z.infer<typeof fundsKindSchema>;

export const operationSchema = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  legacyId: z.string(),
  date: z.string(),
  type: opTypeSchema,
  source: opSourceSchema,
  fromName: z.string().nullable(),
  toName: z.string().nullable(),
  cur1: z.string().nullable(),
  amount1: z.string().nullable(),
  cur2: z.string().nullable(),
  amount2: z.string().nullable(),
  rate: z.string().nullable(),
  avgPrice: z.string().nullable(),
  priceUsd: z.string().nullable(),
  posType: z.string().nullable(),
  funds: fundsKindSchema.nullable(),
  loanRate: z.string().nullable(),
  loanRateTake: z.string().nullable(),
  loanFromName: z.string().nullable(),
  loanPosLegacyId: z.string().nullable(),
  loanLtv: z.string().nullable(),
  loanLiqPct: z.string().nullable(),
  loanLiqPrice: z.string().nullable(),
  loanCollateralUsd: z.string().nullable(),
  network: z.string().nullable(),
  commissionNetwork: z.string().nullable(),
  closeTokenAmount: z.string().nullable(),
  direction: z.string().nullable(),
  comment: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Operation = z.infer<typeof operationSchema>;

const operationsListSchema = z.array(operationSchema);

export const operationsStatsSchema = z.object({
  count: z.number().int(),
  lastUpdatedAt: z.string().datetime().nullable(),
});
export type OperationsStats = z.infer<typeof operationsStatsSchema>;

export const importResultSchema = z.object({
  inserted: z.number().int(),
  updated: z.number().int(),
  total: z.number().int(),
});
export type ImportResult = z.infer<typeof importResultSchema>;

export interface OperationsListFilter {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

const dateOnlyRegex = /^\d{4}-\d{2}-\d{2}$/;
const numericRegex = /^-?\d+(\.\d+)?$/;

const numericStr = z.string().regex(numericRegex, "expected numeric").nullable().optional();
const text = (max: number) => z.string().max(max).nullable().optional();

export const importItemSchema = z.object({
  legacyId: z.string().min(1).max(120),
  date: z.string().regex(dateOnlyRegex, "expected YYYY-MM-DD"),
  type: opTypeSchema,
  source: opSourceSchema.optional(),
  fromName: text(200),
  toName: text(200),
  cur1: text(60),
  amount1: numericStr,
  cur2: text(60),
  amount2: numericStr,
  rate: numericStr,
  avgPrice: numericStr,
  priceUsd: numericStr,
  posType: text(60),
  funds: fundsKindSchema.nullable().optional(),
  loanRate: numericStr,
  loanRateTake: numericStr,
  loanFromName: text(200),
  loanPosLegacyId: text(120),
  loanLtv: numericStr,
  loanLiqPct: numericStr,
  loanLiqPrice: numericStr,
  loanCollateralUsd: numericStr,
  network: text(60),
  commissionNetwork: text(60),
  closeTokenAmount: numericStr,
  direction: text(60),
  comment: z.string().max(2000).optional(),
});
export type ImportItem = z.infer<typeof importItemSchema>;

export const importItemsSchema = z.array(importItemSchema).min(1).max(5000);

function toQuery(f: OperationsListFilter): string {
  const p = new URLSearchParams();
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.limit !== undefined) p.set("limit", String(f.limit));
  if (f.offset !== undefined) p.set("offset", String(f.offset));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const operationsApi = {
  list: (accountId: string, filter: OperationsListFilter = {}) =>
    api.get(
      `/v1/accounts/${accountId}/operations${toQuery(filter)}`,
      operationsListSchema
    ),

  stats: (accountId: string) =>
    api.get(
      `/v1/accounts/${accountId}/operations/stats`,
      operationsStatsSchema
    ),

  import: (accountId: string, items: ImportItem[]) =>
    api.post(
      `/v1/accounts/${accountId}/operations/import`,
      { items },
      importResultSchema
    ),

  delete: (accountId: string, operationId: string) =>
    api.delete(
      `/v1/accounts/${accountId}/operations/${operationId}`,
      z.unknown()
    ),
};
