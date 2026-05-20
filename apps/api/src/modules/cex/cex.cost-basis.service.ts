import { isStableSymbol } from "../classifier/protocols.js";

import type {
  CexAccountRow,
  CexP2pOrderRow,
  CexRepository,
  CexTradeRow,
  CexTransferRow,
} from "./cex.repository.js";
import { canonicalSymbol } from "./wrapped-symbols.js";

/**
 * Cost-basis chain across a CEX account.
 *
 * Walks every CEX event for one account in CHRONOLOGICAL order and
 * maintains a weighted-average-cost (WAC) pool per asset. The output
 * is, for each withdrawal that left the exchange with a tx_hash, the
 * USD cost basis of the crypto that walked out.
 *
 * Pairing happens later: client-side, when the dashboard sees an
 * on-chain operation with the SAME tx_hash on the user's wallet, it
 * looks up this cost basis and uses it as the wallet's startUsd for
 * those tokens. That's how a fiat investment becomes the dashboard's
 * "Стартовый капитал" even though the money traveled
 * Fiat → P2P → Trade → Withdrawal → On-chain.
 *
 * Event types and pool effects:
 *
 *   P2P-buy   (user paid fiat, got crypto)
 *       cost = fiatAmount converted to USD on the trade date
 *       → ADD (amount, cost) to pool[asset]
 *
 *   P2P-sell  (user sold crypto for fiat)
 *       → REMOVE (amount) from pool[asset]; the realised cost basis
 *         leaves the system (user got fiat, which we don't track here)
 *
 *   Spot trade  ("BTC/USDT" buy: bought BTC, paid USDT)
 *       removed = REMOVE quoteAmount from pool[quote] (proportional WAC)
 *       → ADD (baseAmount, removed) to pool[base]
 *     (sell is the mirror)
 *
 *   Deposit  (crypto came in from on-chain, unknown cost basis at CEX)
 *       → ADD (amount, 0) — the crypto exists in the pool but with
 *         zero cost. Phase 4 will plumb on-chain cost basis IN.
 *
 *   Withdrawal  (crypto left to an external address)
 *       removed = REMOVE (amount) from pool[asset]
 *       → record { id: withdrawal.id, txHash, costUsd: removed }
 *
 * Fiat → USD conversion:
 *   The retail Bitget tax API doesn't give us the fiat leg, so we
 *   only have data when the user typed it in (manual or CSV import).
 *   Conversion table:
 *     - fiat = USD                → costUsd = fiatAmount
 *     - asset is USD-pegged stable → costUsd = amount (1:1, ignoring
 *       small Bitget P2P premium ≈ 1-3%)
 *     - else                      → costUsd = 0 + warning
 *       (will integrate historical FX rates in Phase 4)
 */

const STABLE_USD = new Set(["USDT", "USDC", "DAI", "TUSD", "BUSD", "PYUSD", "USDS"]);

export interface WithdrawalCostBasis {
  readonly cexAccountId: string;
  readonly exchange: string;
  readonly label: string | null;
  readonly transferId: string;
  readonly txHash: string;
  readonly asset: string;
  readonly amount: number;
  /**
   * USD-стоимость cost basis именно ДЛЯ `amount` (что пришло на адрес
   * получателя). После UCB D1 этот номер уже ИСКЛЮЧАЕТ стоимость fee —
   * fee tracked отдельно как `feeLossUsd` (realized loss).
   */
  readonly costBasisUsd: number;
  /**
   * UCB D1: cost basis fee'я в USD (proportional from pool). Это
   * realized loss at withdrawal time. 0 если fee нет / unknown.
   */
  readonly feeLossUsd: number;
  /** Asset, в котором exchange списал fee (обычно тот же, что `asset`). */
  readonly feeAsset: string | null;
  /** Amount fee'я (in feeAsset units). */
  readonly feeAmount: number;
  /**
   * Source of truth on which the cost basis was derived. Useful for UI
   * to express confidence:
   *   - 'fiat-direct'    — fiat-leg known via CSV/manual entry, USD math is exact
   *   - 'fiat-stable'    — asset is USDT/USDC/… so amount ≈ USD; approximation
   *   - 'inherited'      — cost basis flowed from a prior trade/buy in the pool
   *   - 'unknown'        — couldn't derive (no fiat leg + asset isn't stable)
   */
  readonly source:
    | "fiat-direct"
    | "fiat-stable"
    | "inherited"
    | "unknown";
  readonly executedAt: Date;
}

interface PoolState {
  totalAmount: number;
  totalCostUsd: number;
  /** Records which event types contributed. Used to flag the source. */
  hasFiat: boolean;
}

type Event =
  | {
      kind: "p2p";
      ts: number;
      row: CexP2pOrderRow;
    }
  | {
      kind: "trade";
      ts: number;
      row: CexTradeRow;
    }
  | {
      kind: "transfer";
      ts: number;
      row: CexTransferRow;
    };

export class CexCostBasisService {
  constructor(
    private readonly cexRepo: CexRepository,
    /**
     * UCB D2: Historical FX service для P2P в non-USD фиате. Optional —
     * если не передан, fall back на старую logic (USD-direct + stable-1:1).
     * Сделано optional чтобы тесты CexCostBasisService без необходимости
     * mock'ать FX service.
     */
    private readonly fx?: import("./historical-fx.service.js").HistoricalFxService,
    /**
     * UCB C1: deposit seeds service — bulk lookup `txHash → costBasisUsd`
     * для on-chain → CEX deposits. Optional: если не передан, deposits
     * получают cost=0 (non-stable) / amount (stable) как раньше.
     */
    private readonly seeds?: {
      resolveCostBasisByHash(
        userId: string,
        txHashes: readonly string[],
      ): Promise<Map<string, number>>;
    },
  ) {}

  async computeForUser(userId: string): Promise<WithdrawalCostBasis[]> {
    const accounts = await this.cexRepo.listActiveForUser(userId);
    const out: WithdrawalCostBasis[] = [];
    for (const acc of accounts) {
      const perAccount = await this.computeForAccount(acc);
      out.push(...perAccount);
    }
    return out;
  }

  private async computeForAccount(
    acc: CexAccountRow
  ): Promise<WithdrawalCostBasis[]> {
    const [p2p, trades, transfers] = await Promise.all([
      this.cexRepo.listP2pOrdersForAccountAsc(acc.id),
      this.cexRepo.listTradesForAccount(acc.id),
      this.cexRepo.listTransfersForAccountAsc(acc.id),
    ]);

    // UCB D2: pre-fetch historical FX rates for non-USD P2P orders. Делаем
    // batch-fetch одним вызовом — applyP2p потом синхронно lookup'ает rate
    // из готовой map. Если this.fx не передан или upstream упал — fxRates
    // остаётся пустой, и fiatToUsd fallback'ится на legacy logic.
    const fxRates = new Map<string, number>();
    if (this.fx) {
      const needs = p2p
        .filter(
          (r) =>
            r.fiatCurrency &&
            r.fiatCurrency.toUpperCase() !== "USD" &&
            r.fiatAmount,
        )
        .map((r) => ({
          currency: r.fiatCurrency as string,
          date: r.executedAt,
        }));
      if (needs.length > 0) {
        try {
          const fetched = await this.fx.batchGetRates(needs);
          for (const [k, v] of fetched) fxRates.set(k, v);
        } catch {
          // Silent: fxRates пустая → fallback на stable-1:1 / unknown.
        }
      }
    }

    // UCB C1: pre-fetch deposit seeds для всех deposit'ов c tx hash.
    // Один bulk query вместо per-event roundtrip'ов.
    const depositSeedsMap = new Map<string, number>();
    if (this.seeds) {
      const depositHashes = transfers
        .filter((t) => t.direction === "deposit" && t.txHash)
        .map((t) => t.txHash as string);
      if (depositHashes.length > 0) {
        try {
          const fetched = await this.seeds.resolveCostBasisByHash(
            acc.userId,
            depositHashes,
          );
          for (const [k, v] of fetched) depositSeedsMap.set(k, v);
        } catch {
          // Silent: seeds map пустая → applyDeposit fallback'ится.
        }
      }
    }

    const events: Event[] = [
      ...p2p.map((r): Event => ({ kind: "p2p", ts: r.executedAt.getTime(), row: r })),
      ...trades.map(
        (r): Event => ({ kind: "trade", ts: r.executedAt.getTime(), row: r })
      ),
      ...transfers.map(
        (r): Event => ({ kind: "transfer", ts: r.executedAt.getTime(), row: r })
      ),
    ].sort((a, b) => a.ts - b.ts);

    const pools = new Map<string, PoolState>();
    const out: WithdrawalCostBasis[] = [];

    for (const ev of events) {
      if (ev.kind === "p2p") {
        this.applyP2p(pools, ev.row, fxRates);
      } else if (ev.kind === "trade") {
        this.applyTrade(pools, ev.row);
      } else {
        // transfer
        if (ev.row.direction === "deposit") {
          this.applyDeposit(pools, ev.row, depositSeedsMap);
        } else {
          const wd = this.applyWithdrawal(pools, ev.row, acc);
          if (wd) out.push(wd);
        }
      }
    }
    return out;
  }

  private applyP2p(
    pools: Map<string, PoolState>,
    r: CexP2pOrderRow,
    fxRates: ReadonlyMap<string, number>,
  ): void {
    const asset = r.asset.toUpperCase();
    const poolKey = canonicalSymbol(asset);
    const amount = Number(r.amount);
    if (!Number.isFinite(amount) || amount <= 0) return;

    if (r.side === "buy") {
      // User paid fiat → got crypto. Add to pool with USD cost.
      const costUsd = this.fiatToUsd(
        asset,
        amount,
        r.fiatCurrency,
        r.fiatAmount,
        r.executedAt,
        fxRates,
      );
      add(pools, poolKey, amount, costUsd, costUsd > 0);
    } else if (r.side === "sell") {
      // User sent crypto, got fiat. Remove from pool — realized cost
      // exits the chain (we don't follow outgoing fiat).
      remove(pools, poolKey, amount);
    }
  }

  private applyTrade(pools: Map<string, PoolState>, t: CexTradeRow): void {
    // symbol is "BASE/QUOTE", e.g. "BTC/USDT".
    const parts = t.symbol.split("/");
    if (parts.length !== 2) return;
    const [baseRaw, quoteRaw] = parts;
    if (!baseRaw || !quoteRaw) return;
    // UCB D4: route pools through canonical (unwrapped) symbol so that
    // a `BTC/USDT` trade and a `WBTC` withdrawal share a pool. Stable-
    // check still uses the surface symbol because the alias map covers
    // only 1:1 wrapped tokens, not pegged stables.
    const baseQuoted = baseRaw.toUpperCase();
    const quoteQuoted = quoteRaw.toUpperCase();
    const base = canonicalSymbol(baseQuoted);
    const quote = canonicalSymbol(quoteQuoted);
    const baseAmount = Number(t.amount);
    const quoteAmount = Number(t.cost);
    if (!Number.isFinite(baseAmount) || baseAmount <= 0) return;
    if (!Number.isFinite(quoteAmount) || quoteAmount <= 0) return;

    if (t.side === "buy") {
      // Bought BASE for QUOTE. Pull cost out of quote pool, push to base.
      const removedCost = remove(pools, quote, quoteAmount);
      const hadFiat = pools.get(quote)?.hasFiat ?? false;
      // If quote is a USD-stable AND we removed amount but pool was
      // empty (no prior buy registered), seed the inherited cost from
      // the stable's USD-equivalent. Without this, withdrawals after a
      // deposit-then-trade leave with zero cost.
      const seedCost = removedCost > 0
        ? removedCost
        : isStableSymbol(quoteQuoted)
          ? quoteAmount
          : 0;
      add(pools, base, baseAmount, seedCost, hadFiat || seedCost > 0);
    } else if (t.side === "sell") {
      // Sold BASE for QUOTE.
      const removedCost = remove(pools, base, baseAmount);
      const hadFiat = pools.get(base)?.hasFiat ?? false;
      const seedCost = removedCost > 0
        ? removedCost
        : isStableSymbol(quoteQuoted)
          ? quoteAmount
          : 0;
      add(pools, quote, quoteAmount, seedCost, hadFiat || seedCost > 0);
    }
  }

  private applyDeposit(
    pools: Map<string, PoolState>,
    t: CexTransferRow,
    seedsByHash: ReadonlyMap<string, number>,
  ): void {
    const asset = t.asset.toUpperCase();
    const poolKey = canonicalSymbol(asset);
    const amount = Number(t.amount);
    if (!Number.isFinite(amount) || amount <= 0) return;
    // UCB C1: если client заранее POST'ил seed для этого txHash —
    // используем его как cost basis. Это закрывает разрыв «on-chain
    // wallet has $X cost basis для этой 1 BTC → withdrew → CEX знает
    // что cost = $X», иначе CEX side стартует с cost=0 / amount stable.
    const txHash = t.txHash?.toLowerCase();
    const seeded = txHash != null ? seedsByHash.get(txHash) : undefined;
    if (seeded != null && Number.isFinite(seeded) && seeded >= 0) {
      // hadFiat=true потому что seed = real money trail (client посчитал).
      add(pools, poolKey, amount, seeded, true);
      return;
    }
    // Fallback (legacy): deposit from on-chain — cost basis is unknown
    // at the CEX side (the user already had this crypto somewhere).
    // Add zero-cost. If the asset is a USD-pegged stable we approximate
    // cost = amount.
    if (isStableSymbol(asset)) {
      add(pools, poolKey, amount, amount, false);
    } else {
      add(pools, poolKey, amount, 0, false);
    }
  }

  private applyWithdrawal(
    pools: Map<string, PoolState>,
    t: CexTransferRow,
    acc: CexAccountRow
  ): WithdrawalCostBasis | null {
    if (!t.txHash) return null;
    const asset = t.asset.toUpperCase();
    // UCB D4: pool routed through canonical (unwrapped) symbol. WBTC
    // withdrawal consumes from BTC pool because exchange wraps at
    // payout. The response still surfaces the original `asset` so on-
    // chain matching by symbol keeps working.
    const poolKey = canonicalSymbol(asset);
    const amount = Number(t.amount);
    if (!Number.isFinite(amount) || amount <= 0) return null;

    // UCB D1: parse fee. Most CEXes deduct fee in same asset as the
    // withdrawal (`feeCurrency === asset`). Some support cross-currency
    // fees (Binance BNB discounts, etc.) — handle both.
    const feeAmountRaw = t.feeAmount != null ? Number(t.feeAmount) : 0;
    const feeAmount = Number.isFinite(feeAmountRaw) && feeAmountRaw > 0
      ? feeAmountRaw
      : 0;
    const feeAsset = t.feeCurrency
      ? t.feeCurrency.toUpperCase()
      : feeAmount > 0
        ? asset // assume same asset if currency missing but amount present
        : null;
    const feePoolKey = feeAsset ? canonicalSymbol(feeAsset) : null;

    const pool = pools.get(poolKey);
    let removedCost: number;
    let feeLossUsd = 0;

    if (feeAmount > 0 && feePoolKey === poolKey) {
      // Same-asset fee (after canonical alias): consume amount + fee
      // from the pool, then split removed cost proportionally. User
      // paid (amount+fee) of asset, recipient got `amount` → fee =
      // realized loss.
      const total = amount + feeAmount;
      const totalCostRemoved = remove(pools, poolKey, total);
      removedCost = totalCostRemoved * (amount / total);
      feeLossUsd = totalCostRemoved * (feeAmount / total);
    } else {
      // Either no fee, or fee in a different currency.
      removedCost = remove(pools, poolKey, amount);
      if (feeAmount > 0 && feePoolKey) {
        // Consume fee from its own pool.
        feeLossUsd = remove(pools, feePoolKey, feeAmount);
        // If fee asset is a USD-stable, approximate fee USD = amount
        // even if pool didn't have cost basis (e.g. fresh BNB topup).
        if (feeLossUsd === 0 && feeAsset && isStableSymbol(feeAsset)) {
          feeLossUsd = feeAmount;
        }
      }
    }

    let source: WithdrawalCostBasis["source"];
    let costBasisUsd = removedCost;
    if (removedCost > 0 && pool?.hasFiat) {
      source = "fiat-direct";
    } else if (removedCost > 0) {
      source = "inherited";
    } else if (isStableSymbol(asset)) {
      // No fiat trail but it's a stable — approximate 1:1.
      costBasisUsd = amount;
      source = "fiat-stable";
    } else {
      source = "unknown";
    }

    return {
      cexAccountId: acc.id,
      exchange: acc.exchange,
      label: acc.label,
      transferId: t.id,
      txHash: t.txHash,
      asset,
      amount,
      costBasisUsd,
      feeLossUsd,
      feeAsset,
      feeAmount,
      source,
      executedAt: t.executedAt,
    };
  }

  /**
   * Convert P2P fiat amount to USD. Resolution order:
   *   1. fiat=USD              → fiatAmount as-is
   *   2. UCB D2: non-USD fiat + historical FX rate available
   *                            → fiatAmount × FX[fiat → USD] on trade date
   *   3. non-USD fiat + asset is USD-stable
   *                            → cost ≈ crypto amount (1:1 stable approx)
   *   4. No fiat leg + stable  → cost ≈ crypto amount (1:1)
   *   5. Else                  → 0 (cost basis unknown; UI flags it)
   *
   * `fxRates` map keyed by `<CCY>|<YYYY-MM-DD>` (см. HistoricalFxService.keyOf).
   * Если карта пустая или нет совпадения — fallback на legacy logic.
   */
  private fiatToUsd(
    asset: string,
    amount: number,
    fiatCurrency: string | null,
    fiatAmount: string | null,
    executedAt: Date,
    fxRates: ReadonlyMap<string, number>,
  ): number {
    if (fiatCurrency && fiatAmount) {
      const fa = Number(fiatAmount);
      if (!Number.isFinite(fa) || fa <= 0) return 0;
      const upper = fiatCurrency.toUpperCase();
      if (upper === "USD") return fa;

      // UCB D2: try historical FX rate first — это самый точный путь
      // когда user paid RUB / EUR / KZT etc. за crypto.
      const dateStr = executedAt.toISOString().slice(0, 10);
      const fxKey = `${upper}|${dateStr}`;
      const rate = fxRates.get(fxKey);
      if (rate != null && rate > 0) {
        return fa * rate;
      }

      // Fallback: non-USD fiat + USD-stable asset — крипта ≈ USD.
      // (1 USDT ≈ $1 независимо от того в RUB или EUR её купили.)
      if (isStableSymbol(asset)) return amount;
      // Non-stable asset paid in non-USD fiat без FX rate — unknown.
      return 0;
    }
    // No fiat leg recorded. If asset is a stable, fall back to 1:1.
    if (isStableSymbol(asset)) return amount;
    return 0;
  }
}

// stable-symbol helper kept in module scope so the worker doesn't need
// re-import paths. (isStableSymbol already imported.)
void STABLE_USD;

function add(
  pools: Map<string, PoolState>,
  asset: string,
  amount: number,
  costUsd: number,
  withFiat: boolean
): void {
  const p = pools.get(asset) ?? {
    totalAmount: 0,
    totalCostUsd: 0,
    hasFiat: false,
  };
  p.totalAmount += amount;
  p.totalCostUsd += costUsd;
  if (withFiat) p.hasFiat = true;
  pools.set(asset, p);
}

function remove(
  pools: Map<string, PoolState>,
  asset: string,
  amount: number
): number {
  const p = pools.get(asset);
  if (!p || p.totalAmount <= 0) return 0;
  const fraction = Math.min(1, amount / p.totalAmount);
  const removedCost = p.totalCostUsd * fraction;
  p.totalAmount -= amount;
  p.totalCostUsd -= removedCost;
  if (p.totalAmount < 1e-12) p.totalAmount = 0;
  if (p.totalCostUsd < 0) p.totalCostUsd = 0;
  pools.set(asset, p);
  return removedCost;
}
