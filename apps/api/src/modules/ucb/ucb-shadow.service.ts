/**
 * B5 — shadow orchestration: when `capflow.feature.ucbServerShadow` is ON for an
 * account, compute the canonical positions server-side and persist them to
 * ucb_shadow_results. NEVER serves; fail-soft (records the error, never throws
 * into the refresh path). Flag default-OFF is automatic (no flag row → false).
 *
 * This is the brain wired into the refresh path (one call in
 * PortfolioRefreshService.refreshAccount, after the live snapshot is assembled).
 * Self-contained + unit-testable with stubbed deps — the flag gate lives HERE,
 * outside the pure `computePositions` engine (which stays IO-free).
 */
import type { LiveSnapshot } from "@cap-flow/ucb/live";
import type { LotMethodology } from "@cap-flow/ucb/lots/types";

import {
  computePositions,
  type OpPriceSource,
  type UcbComputeWallet,
} from "./ucb.service.js";
import type { UcbOpsRepository } from "./ucb-ops.repository.js";
import type {
  UcbShadowRepository,
  UcbShadowTrigger,
} from "./ucb-shadow.repository.js";

export const UCB_SERVER_SHADOW_FLAG = "capflow.feature.ucbServerShadow";

export interface FlagResolver {
  enabled(key: string, ctx: { accountId?: string }): Promise<boolean>;
}

export interface UcbShadowServiceDeps {
  opsRepo: Pick<UcbOpsRepository, "loadComputeWalletsForAccount">;
  shadowRepo: Pick<UcbShadowRepository, "insertResult">;
  opPricingService: OpPriceSource;
  flags: FlagResolver;
  /** `@cap-flow/ucb` pkg version + git sha — stamped on every result. */
  engineVersion: string;
  lotMethodology?: LotMethodology;
}

export interface RunShadowResult {
  /** Flag OFF → nothing computed/written. */
  skipped: boolean;
  id?: string;
  positionCount?: number;
  /** Fail-soft: set when the compute threw (an error row was written). */
  error?: string;
}

export class UcbShadowService {
  constructor(private readonly deps: UcbShadowServiceDeps) {}

  /**
   * Compute + store the account's shadow positions, flag-gated. `liveByWalletId`
   * is the refresh's already-fetched DeBank/Helius snapshot per wallet — attached
   * to each loaded wallet so `buildOpenPositions` can form the open positions.
   */
  async runForAccount(
    accountId: string,
    opts: {
      trigger: UcbShadowTrigger;
      liveByWalletId?: ReadonlyMap<string, LiveSnapshot>;
    },
  ): Promise<RunShadowResult> {
    const on = await this.deps.flags.enabled(UCB_SERVER_SHADOW_FLAG, {
      accountId,
    });
    if (!on) return { skipped: true };

    const lotMethodology: LotMethodology = this.deps.lotMethodology ?? "FIFO";
    try {
      const loaded =
        await this.deps.opsRepo.loadComputeWalletsForAccount(accountId);
      const wallets: UcbComputeWallet[] = loaded.map((w) => {
        const live = opts.liveByWalletId?.get(w.wallet.id);
        return live ? { ...w, live } : w;
      });
      const positions = await computePositions(wallets, {
        opPricingService: this.deps.opPricingService,
        lotMethodology,
      });
      const { id } = await this.deps.shadowRepo.insertResult({
        accountId,
        trigger: opts.trigger,
        lotMethodology,
        positions,
        engineVersion: this.deps.engineVersion,
      });
      return { skipped: false, id, positionCount: positions.length };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      // fail-soft: persist the failure (positions []), never throw into refresh.
      try {
        await this.deps.shadowRepo.insertResult({
          accountId,
          trigger: opts.trigger,
          lotMethodology,
          positions: [],
          engineVersion: this.deps.engineVersion,
          error,
        });
      } catch {
        /* swallow — shadow must never break refresh */
      }
      return { skipped: false, error };
    }
  }
}
