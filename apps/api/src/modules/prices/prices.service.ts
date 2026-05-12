import { NotFoundError } from "../../core/errors.js";
import type { QuotedPriceProvider } from "../integrations/quoted-provider.js";
import type { PriceQuote } from "../integrations/types.js";

import type { PricesRepository } from "./prices.repository.js";

export interface PricesConfig {
  readonly perUserDailyLimit: number;
}

/**
 * Combines coingecko-id resolution with the quota-wrapped provider call.
 *
 * Routes call `getCurrent(symbol, accountId, userId)` → we resolve symbol →
 * coingecko_id (per-account override > global), then ask the provider
 * (which goes through Redis cache + per-user quota + api_usage log).
 */
export class PricesService {
  constructor(
    private readonly repo: PricesRepository,
    private readonly provider: QuotedPriceProvider,
    private readonly cfg: PricesConfig
  ) {}

  async getCurrent(
    symbol: string,
    accountId: string | null,
    userId: string,
    meta: { ip: string | null; userAgent: string | null }
  ): Promise<PriceQuote & { coingeckoId: string; resolvedFrom: string }> {
    const resolved = await this.repo.resolveCoingeckoId(symbol, accountId);
    if (!resolved) {
      throw new NotFoundError(
        `Symbol '${symbol}' not mapped to any coingecko_id (neither in account overrides nor global registry).`
      );
    }
    const quote = await this.provider.getPrice(
      symbol,
      resolved.coingeckoId,
      { userId, accountId, ip: meta.ip, userAgent: meta.userAgent },
      { subjectId: userId, dailyLimit: this.cfg.perUserDailyLimit }
    );
    return {
      ...quote,
      coingeckoId: resolved.coingeckoId,
      resolvedFrom: resolved.source,
    };
  }
}
