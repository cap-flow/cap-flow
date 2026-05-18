/**
 * UCB Bob-test fix #5: CEX asset-gap detection service.
 *
 * Aggregates per-asset inflow/outflow across all user's CEX accounts +
 * runs pure detector. Returns gaps user should investigate (likely
 * missing CCXT deposit history → overstated realized gains).
 */
import type {
  CexRepository,
  CexTradeRow,
  CexTransferRow,
} from "./cex.repository.js";
import {
  detectCexAssetGaps,
  type AssetFlow,
  type AssetGap,
} from "./cex-asset-gap-detector.js";

interface MutableFlow {
  bought: number;
  sold: number;
  deposited: number;
  withdrawn: number;
}

export class CexAssetGapService {
  constructor(private readonly cexRepo: CexRepository) {}

  async detectForUser(userId: string): Promise<AssetGap[]> {
    const accounts = await this.cexRepo.listActiveForUser(userId);
    if (accounts.length === 0) return [];

    const byAsset = new Map<string, MutableFlow>();
    const getFlow = (asset: string): MutableFlow => {
      const a = asset.toUpperCase();
      const cur = byAsset.get(a) ?? {
        bought: 0,
        sold: 0,
        deposited: 0,
        withdrawn: 0,
      };
      byAsset.set(a, cur);
      return cur;
    };

    for (const acc of accounts) {
      const [trades, transfers] = await Promise.all([
        this.cexRepo.listTradesForAccount(acc.id),
        this.cexRepo.listTransfersForAccountAsc(acc.id),
      ]);

      for (const t of trades) this.applyTrade(t, getFlow);
      for (const t of transfers) this.applyTransfer(t, getFlow);
    }

    const flows: AssetFlow[] = [];
    for (const [asset, f] of byAsset) {
      flows.push({
        asset,
        bought: f.bought,
        sold: f.sold,
        deposited: f.deposited,
        withdrawn: f.withdrawn,
      });
    }
    return detectCexAssetGaps(flows);
  }

  private applyTrade(
    t: CexTradeRow,
    getFlow: (asset: string) => MutableFlow,
  ): void {
    const parts = t.symbol.split("/");
    if (parts.length !== 2) return;
    const base = parts[0]!.toUpperCase();
    const baseAmount = Number(t.amount);
    if (!Number.isFinite(baseAmount) || baseAmount <= 0) return;

    const flow = getFlow(base);
    if (t.side === "buy") {
      flow.bought += baseAmount;
    } else if (t.side === "sell") {
      flow.sold += baseAmount;
    }
  }

  private applyTransfer(
    t: CexTransferRow,
    getFlow: (asset: string) => MutableFlow,
  ): void {
    const amount = Number(t.amount);
    if (!Number.isFinite(amount) || amount <= 0) return;
    const flow = getFlow(t.asset);
    if (t.direction === "deposit") {
      flow.deposited += amount;
    } else if (t.direction === "withdrawal") {
      flow.withdrawn += amount;
    }
  }
}
