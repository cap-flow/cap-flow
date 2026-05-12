import type { AuditService } from "../audit/audit.service.js";
import type { ChainClassifierService } from "../classifier/chain_classifier.service.js";
import { computeCostBasis } from "../cost-basis/cost-basis.js";
import type { DeBankClient } from "../integrations/debank.js";
import type { HeliusClient } from "../integrations/helius.js";
import type { ApiUsageRepository } from "../api-usage/api-usage.repository.js";
import type { OperationsRepository } from "../operations/operations.repository.js";
import type { WalletsRepository } from "../wallets/wallets.repository.js";

import type { IPortfolioRepository } from "./portfolio.repository.js";

export interface RefreshResult {
  readonly snapshotId: string;
  readonly date: string;
  readonly metrics: Record<string, unknown>;
  readonly durationMs: number;
  readonly trigger: "cron" | "manual";
}

/**
 * Stage-2/3c refresh pipeline.
 *
 *   EVM addresses → DeBank `total_usd_value` (one call per address covers
 *                   every chain DeBank supports; ~7 we care about).
 *   Solana       → Helius v0/addresses balances. SOL native value is
 *                   converted to USD only if a `solUsd` is provided
 *                   (callers can pass one via env or a CoinGecko hit
 *                   wrapper); per-SPL pricing is informational until
 *                   we wire `coingecko_registry` lookup by mint address.
 *   Tron / BTC / other → recorded in `metrics.addressesSkipped`.
 *
 * Cost basis / per-position math intentionally **not** done here — that
 * requires the `operations` ledger ported server-side (next phase).
 *
 * Wired with `WalletsRepository` (not `WalletsService`) because the
 * worker is a trusted service path — no AuthUser tenant check needed.
 */
export class PortfolioRefreshService {
  constructor(
    private readonly portfolio: IPortfolioRepository,
    private readonly audit: AuditService,
    private readonly wallets: WalletsRepository,
    private readonly debank: DeBankClient,
    private readonly helius: HeliusClient,
    private readonly apiUsage: ApiUsageRepository,
    private readonly operations: OperationsRepository,
    private readonly chainClassifier: ChainClassifierService
  ) {}

  async refreshAccount(args: {
    accountId: string;
    trigger: "cron" | "manual";
    actorUserId?: string | null;
  }): Promise<RefreshResult> {
    const startedAt = Date.now();

    const addresses = await this.wallets.listAddressesByAccount(args.accountId);
    const evmAddrs = addresses.filter((a) => a.type === "evm");
    const solAddrs = addresses.filter((a) => a.type === "solana");
    const otherSkipped = addresses.filter(
      (a) => a.type !== "evm" && a.type !== "solana"
    );

    let totalUsd = 0;
    const perAddress: Array<{
      address: string;
      walletName: string;
      kind: "evm" | "solana";
      totalUsd: number;
      chains: Array<{ id: string; usdValue: number }>;
      tokens?: number;
      error?: string;
    }> = [];
    const providersUsed = new Set<string>();
    const errors: string[] = [];

    // ─── EVM via DeBank ────────────────────────────────────────────
    if (this.debank.isLive) {
      for (const a of evmAddrs) {
        const t0 = Date.now();
        try {
          const bal = await this.debank.getTotalBalance(a.address);
          providersUsed.add("debank");
          totalUsd += bal.totalUsdValue;
          perAddress.push({
            address: a.address,
            walletName: a.walletName,
            kind: "evm",
            totalUsd: bal.totalUsdValue,
            chains: bal.chains,
          });
          await this.logUsage("debank", "user/total_balance", 200, t0, args.accountId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${a.address}: ${msg.slice(0, 200)}`);
          perAddress.push({
            address: a.address,
            walletName: a.walletName,
            kind: "evm",
            totalUsd: 0,
            chains: [],
            error: msg.slice(0, 200),
          });
          await this.logUsage(
            "debank",
            "user/total_balance",
            0,
            t0,
            args.accountId,
            msg
          );
        }
      }
    }

    // ─── Solana via Helius (informational — token USD pricing deferred) ──
    if (this.helius.isLive) {
      for (const a of solAddrs) {
        const t0 = Date.now();
        try {
          const bal = await this.helius.getBalances(a.address);
          providersUsed.add("helius");
          // We don't roll Solana into totalUsd yet — per-SPL pricing
          // needs mint→cg_id resolution, which isn't wired. Record the
          // raw balances so the admin can still see "this Solana wallet
          // has N tokens" and we'll start pricing in the next iteration.
          perAddress.push({
            address: a.address,
            walletName: a.walletName,
            kind: "solana",
            totalUsd: 0,
            chains: [
              {
                id: "solana",
                usdValue: 0,
              },
            ],
            tokens: bal.tokens.length,
          });
          await this.logUsage("helius", "v0/addresses/balances", 200, t0, args.accountId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${a.address}: ${msg.slice(0, 200)}`);
          perAddress.push({
            address: a.address,
            walletName: a.walletName,
            kind: "solana",
            totalUsd: 0,
            chains: [],
            error: msg.slice(0, 200),
          });
          await this.logUsage(
            "helius",
            "v0/addresses/balances",
            0,
            t0,
            args.accountId,
            msg
          );
        }
      }
    }

    // ─── Phase 4d: cost-basis from operations ledger ──────────────────
    // Independent of upstream provider success — even if DeBank/Helius
    // failed, ledger-based WAC remains computable. Failures here are
    // swallowed into metrics.costBasisError so a malformed row can't
    // break the whole refresh.
    let costBasis: Array<{
      symbol: string;
      avgUsd: number;
      runningAmount: number;
      totalPaidUsd: number;
    }> = [];
    let costBasisError: string | undefined;
    let operationsCount = 0;
    try {
      const ops = await this.operations.listAllForReplay(args.accountId);
      operationsCount = ops.length;
      const result = computeCostBasis(
        ops.map((o) => ({
          date: o.date,
          type: o.type,
          cur1: o.cur1,
          amount1: o.amount1,
          cur2: o.cur2,
          amount2: o.amount2,
          priceUsd: o.priceUsd,
        }))
      );
      costBasis = result.map((c) => ({
        symbol: c.symbol,
        avgUsd: c.avgUsd,
        runningAmount: c.runningAmount,
        totalPaidUsd: c.totalPaidUsd,
      }));
    } catch (err) {
      costBasisError =
        err instanceof Error ? err.message.slice(0, 200) : String(err);
    }

    // ─── Phase 5: chain classifier (feature-gated) ────────────────────
    // Resolves the `chain_classifier.enabled` flag per account. When OFF
    // → no-op, zero overhead. When ON → fetches DeBank/Helius history,
    // runs classifier (P5.3 EVM + P5.4 Solana), reports counts +
    // LP-attribution stats. Fail-soft like ledger cost-basis: any
    // exception lands in `metrics.chainClassifierError` without
    // breaking the refresh.
    let chainClassifier: unknown = null;
    let chainClassifierError: string | undefined;
    try {
      chainClassifier = await this.chainClassifier.analyzeAccount({
        accountId: args.accountId,
        addresses: addresses.map((a) => ({
          address: a.address,
          type: a.type,
        })),
      });
    } catch (err) {
      chainClassifierError =
        err instanceof Error ? err.message.slice(0, 200) : String(err);
    }

    const ts = new Date();
    const dateStr = ts.toISOString().slice(0, 10);
    const legacyId = `auto-${args.trigger}-${ts.getTime()}`;
    const metrics: Record<string, unknown> = {
      stub: providersUsed.size === 0,
      trigger: args.trigger,
      totalUsd,
      addressesEvm: evmAddrs.length,
      addressesSolana: solAddrs.length,
      addressesSkipped: otherSkipped.length,
      refreshedFrom: [...providersUsed],
      errors: errors.slice(0, 5),
      perAddress,
      operationsCount,
      costBasis,
      ...(costBasisError ? { costBasisError } : {}),
      chainClassifier,
      ...(chainClassifierError ? { chainClassifierError } : {}),
      generatedAt: ts.toISOString(),
    };

    const snapshot = await this.portfolio.insertSnapshot({
      accountId: args.accountId,
      legacyId,
      date: dateStr,
      isManual: "false",
      metrics,
      positions: null,
    });

    const durationMs = Date.now() - startedAt;

    await this.audit.log({
      actorUserId: args.actorUserId ?? null,
      action:
        args.trigger === "manual"
          ? "portfolio.refresh_manual"
          : "portfolio.refresh_cron",
      accountId: args.accountId,
      payload: {
        snapshotId: snapshot.id,
        durationMs,
        totalUsd,
        addressesProcessed: evmAddrs.length + solAddrs.length,
        errors: errors.length,
      },
    });

    return {
      snapshotId: snapshot.id,
      date: dateStr,
      metrics,
      durationMs,
      trigger: args.trigger,
    };
  }

  private async logUsage(
    provider: "debank" | "helius",
    endpoint: string,
    httpStatus: number,
    t0: number,
    accountId: string,
    error?: string
  ): Promise<void> {
    await this.apiUsage.insert({
      userId: null,
      accountId,
      provider,
      endpoint,
      httpStatus,
      durationMs: Date.now() - t0,
      cacheHit: 0,
      ...(error ? { error: error.slice(0, 500) } : {}),
    });
  }
}
