import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { cexApi, type ConnectCexInput } from "./api";

const KEYS = {
  list: () => ["cex", "list"] as const,
  p2pOrders: (id: string) => ["cex", "p2p-orders", id] as const,
  valuation: () => ["cex", "valuation"] as const,
  transfers: (id: string) => ["cex", "transfers", id] as const,
  transfersWithHash: () => ["cex", "transfers-with-hash"] as const,
  ledger: (id: string) => ["cex", "ledger", id] as const,
};

export function useCexAccounts() {
  return useQuery({
    queryKey: KEYS.list(),
    queryFn: () => cexApi.list(),
    staleTime: 30_000,
  });
}

export function useConnectCex() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ConnectCexInput) => cexApi.connect(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.list() });
    },
  });
}

export function useDisconnectCex() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => cexApi.disconnect(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.list() });
    },
  });
}

export function useSyncCex() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => cexApi.sync(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.list() });
    },
  });
}

/**
 * UCB B1.4: re-probe permissions без полного sync. Возвращает свежий
 * snapshot permissions и инвалидирует список аккаунтов.
 */
export function useReProbeCex() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => cexApi.reProbe(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.list() });
    },
  });
}

/**
 * UCB UX-improvement: одна кнопка «Sync All» которая последовательно
 * запускает balance/trades + transfers + P2P (где поддерживается).
 *
 * Раньше юзеру приходилось нажимать 3 разные кнопки в разных secciones
 * карточки. Это критичный UX-долг — пропускали transfers (Bob так
 * пропустил Bybit transfers и не увидел ETH withdrawal'ов).
 *
 * Returns aggregated status:
 *   - balance/trades result
 *   - transfers result (если успешен)
 *   - p2p result (если биржа поддерживает)
 */
export function useSyncCexAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      // UCB unified sync: ВСЁ за один клик.
      //   - main /sync: balance + trades + (chained: ledger via opportunistic
      //     chain inside service)
      //   - transfers-sync: deposits + withdrawals + (chained: internal transfers)
      //   - p2p-sync: P2P orders (если биржа поддерживает)
      //   - ledger-sync: explicit call для cases где main /sync chain failed
      //   - internal-transfers-sync: explicit fallback
      const main = await cexApi.sync(id);
      const transfers = await cexApi.syncTransfers(id).catch((e) => ({
        ok: false,
        newDeposits: 0,
        newWithdrawals: 0,
        error: (e as Error).message,
      }));
      const p2p = await cexApi.syncP2p(id).catch((e) => ({
        ok: false,
        supported: false,
        newOrders: 0,
        error: (e as Error).message,
      }));
      // UCB B4: ledger explicit (опportunistic chain в main /sync уже
      // запустил, но повторный вызов идемпотентен — он только pull'ит
      // новые entries since last sync timestamp, что обычно 0).
      const ledger = await cexApi.syncLedger(id).catch((e) => ({
        ok: false,
        newCount: 0,
        error: (e as Error).message,
      }));
      // UCB B3: internal transfers explicit fallback
      const internal = await cexApi
        .syncInternalTransfers(id)
        .catch((e) => ({
          ok: false,
          newCount: 0,
          error: (e as Error).message,
        }));
      return { main, transfers, p2p, ledger, internal };
    },
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: KEYS.list() });
      qc.invalidateQueries({ queryKey: KEYS.p2pOrders(id) });
      qc.invalidateQueries({ queryKey: ["cex", "transfers", id] });
      qc.invalidateQueries({ queryKey: KEYS.ledger(id) });
      qc.invalidateQueries({ queryKey: ["cex", "withdrawal-cost-basis"] });
    },
  });
}

export function useSyncCexP2p() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => cexApi.syncP2p(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: KEYS.list() });
      qc.invalidateQueries({ queryKey: KEYS.p2pOrders(id) });
    },
  });
}

export function useCexP2pOrders(id: string | null) {
  return useQuery({
    queryKey: id ? KEYS.p2pOrders(id) : ["cex", "p2p-orders", "none"],
    queryFn: () => cexApi.listP2pOrders(id!),
    enabled: !!id,
    staleTime: 30_000,
  });
}

/**
 * Manually set fiat fields on a single P2P order. Invalidates the
 * orders list AND the cost-basis projections — fiat input is the
 * source of truth for both.
 */
export function useAnnotateP2pOrder(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      orderId,
      ...body
    }: {
      orderId: string;
      fiatCurrency: string | null;
      fiatAmount: number | null;
      unitPrice?: number;
      counterparty?: string | null;
      paymentMethod?: string | null;
    }) => cexApi.annotateP2pOrder(orderId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.p2pOrders(accountId) });
      qc.invalidateQueries({ queryKey: ["cex", "withdrawal-cost-basis"] });
    },
  });
}

/**
 * Create a P2P order by hand. Used for exchanges without a public
 * P2P API (BingX), or for trades outside the exchange's API retention.
 */
export function useCreateManualP2pOrder(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      side: "buy" | "sell";
      asset: string;
      amount: number;
      fiatCurrency: string;
      fiatAmount: number;
      unitPrice?: number;
      counterparty?: string | null;
      paymentMethod?: string | null;
      status?: string;
      executedAt: string;
    }) => cexApi.createManualP2pOrder(accountId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.p2pOrders(accountId) });
      qc.invalidateQueries({ queryKey: ["cex", "withdrawal-cost-basis"] });
    },
  });
}

/**
 * Bulk import fiat data from a Bitget P2P CSV export.
 */
export function useImportP2pCsv(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      rows: ReadonlyArray<{
        orderId: string;
        fiatCurrency: string;
        fiatAmount: number;
        unitPrice?: number;
        counterparty?: string | null;
        paymentMethod?: string | null;
      }>,
    ) => cexApi.importP2pCsv(accountId, rows),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.p2pOrders(accountId) });
      qc.invalidateQueries({ queryKey: ["cex", "withdrawal-cost-basis"] });
    },
  });
}

/**
 * UCB B6: bulk import trade-history from CSV/XLSX биржи. Invalidates
 * trades + cost-basis queries чтобы UI пересчитал coverage.
 */
export function useImportTradesCsv(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      rows: ReadonlyArray<{
        exchangeTradeId: string;
        symbol: string;
        side: "buy" | "sell";
        amount: number;
        price: number;
        cost: number;
        feeCurrency?: string | null;
        feeAmount?: number | null;
        executedAt: string;
      }>,
    ) => cexApi.importTradesCsv(accountId, rows),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.list() });
      qc.invalidateQueries({ queryKey: ["cex", "withdrawal-cost-basis"] });
    },
  });
}

/**
 * Total USD across all of the user's CEX accounts, plus per-account
 * breakdown. Stale time 60s — Capital summary doesn't need real-time
 * accuracy, and we want to avoid pinging CoinGecko on every render.
 */
export function useCexValuation() {
  return useQuery({
    queryKey: KEYS.valuation(),
    queryFn: () => cexApi.valuation(),
    staleTime: 60_000,
  });
}

/* ──────────── Transfers (deposits / withdrawals) ──────────── */

export function useSyncCexTransfers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => cexApi.syncTransfers(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: KEYS.list() });
      qc.invalidateQueries({ queryKey: KEYS.transfers(id) });
      qc.invalidateQueries({ queryKey: KEYS.transfersWithHash() });
    },
  });
}

export function useCexTransfers(id: string | null) {
  return useQuery({
    queryKey: id ? KEYS.transfers(id) : ["cex", "transfers", "none"],
    queryFn: () => cexApi.listTransfers(id!),
    enabled: !!id,
    staleTime: 30_000,
  });
}

/* ──────────── Ledger (master record) ──────────── */
// UCB B4: comprehensive entry-level stream через CCXT fetchLedger.

export function useSyncCexLedger() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => cexApi.syncLedger(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: KEYS.list() });
      qc.invalidateQueries({ queryKey: KEYS.ledger(id) });
    },
  });
}

export function useCexLedger(id: string | null) {
  return useQuery({
    queryKey: id ? KEYS.ledger(id) : ["cex", "ledger", "none"],
    queryFn: () => cexApi.listLedger(id!),
    enabled: !!id,
    staleTime: 30_000,
  });
}

/**
 * All CEX transfers with on-chain tx_hash across every connected
 * exchange — used by Registry/operations views to render the "↔ CEX"
 * badge on on-chain ops that pair with a CEX deposit/withdrawal.
 */
export function useCexTransfersWithHash() {
  return useQuery({
    queryKey: KEYS.transfersWithHash(),
    queryFn: () => cexApi.listAllTransfersWithHash(),
    staleTime: 60_000,
  });
}

/**
 * Per-withdrawal cost basis from the CEX chain. Keyed by tx_hash so
 * Registry can quickly look up "what's the USD cost of THIS on-chain
 * receipt that came from a CEX?" and render "from fiat" badge plus
 * feed it into Capital Hero's «Стартовый капитал».
 */
export function useCexWithdrawalCostBasis() {
  return useQuery({
    queryKey: ["cex", "withdrawal-cost-basis"] as const,
    queryFn: () => cexApi.withdrawalCostBasis(),
    staleTime: 60_000,
  });
}

/**
 * UCB C1: batch-upload deposit seeds (computed client-side через
 * `computeDepositSeedsFromOps`) на server. Idempotent per-user-by-hash.
 * После успешного upsert invalidate'ит `withdrawal-cost-basis` чтобы
 * server пересчитал withdraw cost basis с учётом seeded deposits.
 */
/**
 * Tax T4: CEX-side tax events (P2P sales + trade dispositions).
 * Mergeable с on-chain `generateTaxEvents` для unified tax report.
 */
/**
 * Bob-test fix #5: CEX asset gaps (sold/withdrawn > bought/deposited).
 * Used by Sync Coverage page to surface "missing acquisition" warnings.
 */
export function useCexAssetGaps() {
  return useQuery({
    queryKey: ["cex", "asset-gaps"] as const,
    queryFn: () => cexApi.assetGaps(),
    staleTime: 60_000,
  });
}

export function useCexTaxEvents() {
  return useQuery({
    queryKey: ["cex", "tax-events"] as const,
    queryFn: () => cexApi.taxEventsList(),
    staleTime: 60_000,
  });
}

export function useUpsertDepositSeeds() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      seeds: ReadonlyArray<{
        txHash: string;
        chain: string;
        costBasisUsd: number;
        walletId: string | null;
        note: string | null;
      }>,
    ) => cexApi.depositSeedsUpsert(seeds),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ["cex", "withdrawal-cost-basis"],
      });
    },
  });
}

/* ──────────── Sync ALL connected CEX accounts ──────────── */

/**
 * P2P sync makes sense only when we have a real adapter — for now
 * that's Bitget. Other exchanges silently return `supported:false`,
 * which is correct but wastes a roundtrip when we know in advance.
 */
const P2P_ADAPTER_AVAILABLE: ReadonlySet<string> = new Set(["bitget"]);

export interface SyncAllCexResult {
  readonly account: string;
  readonly exchange: string;
  readonly balance?: { ok: boolean; newTrades: number; error?: string };
  readonly transfers?: {
    ok: boolean;
    newDeposits: number;
    newWithdrawals: number;
    error?: string;
  };
  readonly p2p?: { ok: boolean; newOrders: number; error?: string };
}

/**
 * One-click "обнови всё на CEX": per-account run балансы+трейды +
 * deposits/withdrawals + (если поддерживается) P2P. Аккаунты идут
 * последовательно — биржи поголовно ставят rate-limit, а несколько
 * подключений в параллель быстро упирается в 429. Эндпоинты внутри
 * одного аккаунта тоже последовательно (тот же лимит).
 *
 * Returns aggregated per-account results. Each step's failure is
 * surfaced in its own field — partial success is OK and доходит до
 * UI как «balance ok, transfers fail».
 */
export function useSyncAllCex() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<SyncAllCexResult[]> => {
      const accounts = await cexApi.list();
      const results: SyncAllCexResult[] = [];
      for (const acc of accounts) {
        const result: SyncAllCexResult = {
          account: acc.id,
          exchange: acc.exchange,
        };
        // 1. Балансы + трейды.
        try {
          const r = await cexApi.sync(acc.id);
          result.balance = {
            ok: r.ok,
            newTrades: r.newTrades,
            ...(r.error ? { error: r.error } : {}),
          };
        } catch (e) {
          result.balance = {
            ok: false,
            newTrades: 0,
            error: (e as Error).message,
          };
        }
        // 2. Депозиты + выводы.
        try {
          const r = await cexApi.syncTransfers(acc.id);
          result.transfers = {
            ok: r.ok,
            newDeposits: r.newDeposits,
            newWithdrawals: r.newWithdrawals,
            ...(r.error ? { error: r.error } : {}),
          };
        } catch (e) {
          result.transfers = {
            ok: false,
            newDeposits: 0,
            newWithdrawals: 0,
            error: (e as Error).message,
          };
        }
        // 3. P2P — только для бирж с реальным адаптером.
        if (P2P_ADAPTER_AVAILABLE.has(acc.exchange)) {
          try {
            const r = await cexApi.syncP2p(acc.id);
            result.p2p = {
              ok: r.ok,
              newOrders: r.newOrders,
              ...(r.error ? { error: r.error } : {}),
            };
          } catch (e) {
            result.p2p = {
              ok: false,
              newOrders: 0,
              error: (e as Error).message,
            };
          }
        }
        results.push(result);
      }
      return results;
    },
    onSuccess: () => {
      // Один сброс всех CEX-кэшей в конце вместо invalidate'а на
      // каждом шаге — UI обновится разом, без промежуточных рендеров.
      qc.invalidateQueries({ queryKey: ["cex"] });
    },
  });
}
