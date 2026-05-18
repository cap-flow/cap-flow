import { ForbiddenError } from "../../core/errors.js";
import { isStableSymbol } from "../classifier/protocols.js";
import type {
  PriceLookupContext,
  QuotedPriceProvider,
} from "../integrations/quoted-provider.js";
import type { PricesRepository } from "../prices/prices.repository.js";

import type { CexRepository } from "./cex.repository.js";

/**
 * Sums up USD value of a user's spot balances across all connected CEX
 * accounts, so the dashboard can fold CEX assets into the same capital
 * total it already shows for on-chain wallets.
 *
 * Pricing strategy (cheapest → most expensive):
 *   1. USD-pegged stables → $1 flat (USDT, USDC, DAI, PYUSD, RLUSD, …)
 *   2. Resolve symbol → coingecko_id via PricesRepository
 *   3. Quoted lookup through `QuotedPriceProvider` (Redis cache → quota
 *      → CoinGecko). If the symbol isn't in our registry OR the quota
 *      is exhausted, the asset is marked `priceUsd: null`,
 *      `valueUsd: 0` so the UI can flag "unpriced" without blocking the
 *      rest of the valuation.
 *
 * NB: most exchange dust (mem-coins, retired tokens) is unmapped and
 * stays unpriced. That's intentional — better to undercount than to
 * paper-up the dashboard with bogus zero-volume prices.
 */
export interface CexAssetValuation {
  readonly asset: string;
  readonly total: number;
  /** null when we couldn't get a price (unmapped or quota-exhausted). */
  readonly priceUsd: number | null;
  /** 0 when unpriced — caller distinguishes via `priceUsd === null`. */
  readonly valueUsd: number;
}

export interface CexAccountValuation {
  readonly id: string;
  readonly exchange: string;
  readonly label: string | null;
  readonly totalUsd: number;
  readonly assets: CexAssetValuation[];
  readonly unpricedCount: number;
  /** Set when the snapshot itself is missing (account never synced). */
  readonly neverSynced?: boolean;
}

export interface CexValuationResult {
  readonly totalUsd: number;
  readonly perAccount: CexAccountValuation[];
  readonly unpricedCount: number;
}

export interface CexValuationConfig {
  readonly perUserDailyLimit: number;
}

export class CexValuationService {
  constructor(
    private readonly cexRepo: CexRepository,
    private readonly pricesRepo: PricesRepository,
    private readonly provider: QuotedPriceProvider,
    private readonly cfg: CexValuationConfig
  ) {}

  async valuateForUser(
    userId: string,
    meta: Pick<PriceLookupContext, "ip" | "userAgent">
  ): Promise<CexValuationResult> {
    const accounts = await this.cexRepo.listActiveForUser(userId);
    if (accounts.length === 0) {
      return { totalUsd: 0, perAccount: [], unpricedCount: 0 };
    }

    const perAccount: CexAccountValuation[] = [];
    let grandTotal = 0;
    let grandUnpriced = 0;

    for (const acc of accounts) {
      const lines = await this.cexRepo.latestBalanceSnapshot(acc.id);
      if (lines.length === 0) {
        perAccount.push({
          id: acc.id,
          exchange: acc.exchange,
          label: acc.label,
          totalUsd: 0,
          assets: [],
          unpricedCount: 0,
          neverSynced: true,
        });
        continue;
      }

      const assets: CexAssetValuation[] = [];
      let acctTotal = 0;
      let unpriced = 0;

      for (const line of lines) {
        const total = Number(line.total);
        if (!Number.isFinite(total) || total <= 0) continue;
        const valued = await this.priceOne(
          line.asset,
          acc.accountId,
          userId,
          meta
        );
        const valueUsd = valued.priceUsd != null ? total * valued.priceUsd : 0;
        if (valued.priceUsd == null) unpriced++;
        acctTotal += valueUsd;
        assets.push({
          asset: line.asset,
          total,
          priceUsd: valued.priceUsd,
          valueUsd,
        });
      }

      // Sort assets by valueUsd descending so the UI shows the
      // meaningful positions first; unpriced dust falls to the end.
      assets.sort((a, b) => b.valueUsd - a.valueUsd);
      grandTotal += acctTotal;
      grandUnpriced += unpriced;
      perAccount.push({
        id: acc.id,
        exchange: acc.exchange,
        label: acc.label,
        totalUsd: acctTotal,
        assets,
        unpricedCount: unpriced,
      });
    }

    return {
      totalUsd: grandTotal,
      perAccount,
      unpricedCount: grandUnpriced,
    };
  }

  private async priceOne(
    symbol: string,
    accountId: string,
    userId: string,
    meta: Pick<PriceLookupContext, "ip" | "userAgent">
  ): Promise<{ priceUsd: number | null }> {
    // USD-pegged stables — pin to $1. Cheap and avoids spending quota.
    if (isStableSymbol(symbol)) {
      return { priceUsd: 1 };
    }

    const resolved = await this.pricesRepo.resolveCoingeckoId(symbol, accountId);
    if (!resolved) {
      // Not in registry → almost certainly an exchange-listed memcoin
      // or retired token. Skip without spending quota.
      return { priceUsd: null };
    }

    try {
      const quote = await this.provider.getPrice(
        symbol,
        resolved.coingeckoId,
        {
          userId,
          accountId,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
        },
        { subjectId: userId, dailyLimit: this.cfg.perUserDailyLimit }
      );
      return { priceUsd: quote.priceUsd };
    } catch (e) {
      // Quota exhaustion is the only failure mode we don't want to
      // 5xx on — surface as "unpriced" so the rest of the report
      // still renders.
      if (e instanceof ForbiddenError) return { priceUsd: null };
      throw e;
    }
  }
}
