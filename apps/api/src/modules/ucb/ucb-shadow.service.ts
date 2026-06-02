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
import type { CexCostBasisMatch } from "@cap-flow/ucb/position_coverage";
import type {
  KrystalV3Summary,
  KrystalTransactionsSummary,
} from "@cap-flow/ucb/krystal/adapter";

import {
  computePositions,
  type NonLpOpenerSourceLike,
  type OpPriceSource,
  type UcbComputeWallet,
  type V3EnrichmentSourceLike,
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
  /** B4: non-LP opener source (Etherscan/Alchemy fetch). Absent → no-op. */
  nonLpOpenerSource?: NonLpOpenerSourceLike;
  /** B3-full: non-Krystal V3 enrichment source. Absent → no-op. */
  v3EnrichmentSource?: V3EnrichmentSourceLike;
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
      /** B2: CEX withdrawal cost basis by tx hash (built by the runner). */
      cexCostBasisByHash?: ReadonlyMap<string, CexCostBasisMatch>;
      /** B3: Krystal V3 summaries + per-NFT transactions (built by the runner). */
      krystalV3ByTokenId?: ReadonlyMap<string, KrystalV3Summary>;
      krystalTxByTokenId?: ReadonlyMap<string, KrystalTransactionsSummary>;
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
        ...(this.deps.nonLpOpenerSource !== undefined && {
          nonLpOpenerSource: this.deps.nonLpOpenerSource,
        }),
        ...(this.deps.v3EnrichmentSource !== undefined && {
          v3EnrichmentSource: this.deps.v3EnrichmentSource,
        }),
        ...(opts.cexCostBasisByHash !== undefined && {
          cexCostBasisByHash: opts.cexCostBasisByHash,
        }),
        ...(opts.krystalV3ByTokenId !== undefined && {
          krystalV3ByTokenId: opts.krystalV3ByTokenId,
        }),
        ...(opts.krystalTxByTokenId !== undefined && {
          krystalTxByTokenId: opts.krystalTxByTokenId,
        }),
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
