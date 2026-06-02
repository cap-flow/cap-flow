/**
 * UCB B1 (wiring) — op-pricing cache-fill service.
 *
 * Walks every active account's ops and warms the shared `op_token_prices`
 * cache via `OpPricingService.priceMapForOps` (read) + `fillMissing` (DefiLlama
 * fetch, R5-guarded, bounded). This is what makes server cost basis use
 * DETERMINISTIC block-fixed prices instead of the per-sync `movement.usd`
 * (the sync-time non-determinism behind POS-005 / duplicate_op_divergent_pricing).
 *
 * CACHE-FILL ONLY: writes immutable price facts, serves nothing, flips no flag.
 * Safe and invisible → no feature-flag gate (unlike the B5 shadow runner). Runs
 * as a single global recurring job (concurrency 1), fail-soft per account so one
 * bad account never aborts the sweep.
 */
import type { ClassifiedOp } from "@cap-flow/ucb/types";

import type { PriceNeed } from "./op-pricing.service.js";

/** Enumerates accounts to warm (structural: AccountsRepository.findAllActive). */
export interface AccountLister {
  findAllActive(): Promise<readonly { id: string }[]>;
}

/** Loads an account's wallets+ops (structural: UcbOpsRepository). */
export interface ComputeOpsLoader {
  loadComputeWalletsForAccount(
    accountId: string,
  ): Promise<readonly { ops: ClassifiedOp[] }[]>;
}

/** The cache read+fill surface (structural: OpPricingService). */
export interface OpPricingFillable {
  priceMapForOps(
    ops: readonly ClassifiedOp[],
  ): Promise<{ missing: readonly PriceNeed[] }>;
  fillMissing(
    missing: readonly PriceNeed[],
    signal?: AbortSignal,
  ): Promise<{ written: number }>;
}

export interface OpPricingFillLogger {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
}

export interface OpPricingFillDeps {
  accounts: AccountLister;
  opsRepo: ComputeOpsLoader;
  opPricing: OpPricingFillable;
  logger?: OpPricingFillLogger;
}

export interface OpPricingFillResult {
  /** Active accounts enumerated. */
  accounts: number;
  /** Accounts that threw (fail-soft, skipped). */
  accountsFailed: number;
  /** Total non-failed ops scanned. */
  opsSeen: number;
  /** (coin,bucket) cache misses found. */
  needed: number;
  /** Price rows written to `op_token_prices`. */
  written: number;
}

export class OpPricingFillService {
  constructor(private readonly deps: OpPricingFillDeps) {}

  /**
   * Sweep all active accounts, filling the price cache. Sequential per account
   * (R8 isolation; the job already runs at concurrency 1, and `fillMissing`
   * bounds DefiLlama concurrency internally). Sequential ordering also dedupes
   * across accounts for free: a coin|bucket filled for account A is a cache hit
   * for account B in the same sweep, so it is not re-fetched.
   */
  async run(signal?: AbortSignal): Promise<OpPricingFillResult> {
    const accounts = await this.deps.accounts.findAllActive();
    let opsSeen = 0;
    let needed = 0;
    let written = 0;
    let accountsFailed = 0;

    for (const acc of accounts) {
      if (signal?.aborted) break;
      try {
        const wallets = await this.deps.opsRepo.loadComputeWalletsForAccount(
          acc.id,
        );
        const ops = wallets.flatMap((w) => w.ops);
        opsSeen += ops.length;
        if (ops.length === 0) continue;
        const { missing } = await this.deps.opPricing.priceMapForOps(ops);
        needed += missing.length;
        if (missing.length > 0) {
          const res = await this.deps.opPricing.fillMissing(missing, signal);
          written += res.written;
        }
      } catch (e) {
        accountsFailed++;
        this.deps.logger?.warn("[op-pricing-fill] account failed", {
          accountId: acc.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    const result: OpPricingFillResult = {
      accounts: accounts.length,
      accountsFailed,
      opsSeen,
      needed,
      written,
    };
    this.deps.logger?.info("[op-pricing-fill] done", result);
    return result;
  }
}
