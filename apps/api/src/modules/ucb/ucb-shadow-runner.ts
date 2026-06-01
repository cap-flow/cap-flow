/**
 * B5 (6b core) — assembles the live snapshot and runs the shadow for an account.
 *
 * Decoupled from the 668-line PortfolioRefreshService: rather than thread the
 * refresh's internal DeBank state out, this runner fetches the RAW DeBank per
 * EVM wallet, adapts it to `@cap-flow/ucb` `LiveSnapshot` (the ported
 * adaptDeBankLive), and hands `liveByWalletId` to `UcbShadowService.runForAccount`
 * (which loads ops + computes + stores). The worker calls `run()` after refresh,
 * flag-gated — and the flag is checked HERE first so the extra DeBank fetch only
 * happens when shadow is ON (it is OFF by default; double-fetch is shadow-only).
 *
 * All deps are interfaces → fully unit-testable with the captured raw-DeBank
 * fixture (no live network). The thin bindings (DeBank client → DeBankRawSource,
 * WalletsRepository → WalletAddressSource, worker → run()) are the remaining glue.
 */
import type { LiveSnapshot } from "@cap-flow/ucb/live";
import type { CexCostBasisMatch } from "@cap-flow/ucb/position_coverage";
import type {
  KrystalV3Summary,
  KrystalTransactionsSummary,
} from "@cap-flow/ucb/krystal/adapter";

import {
  adaptDeBankLive,
  type DeBankComplexProtocol,
  type DeBankTokenBalance,
} from "./debank-live.adapter.js";
import {
  UCB_SERVER_SHADOW_FLAG,
  type FlagResolver,
  type RunShadowResult,
} from "./ucb-shadow.service.js";
import type { UcbShadowTrigger } from "./ucb-shadow.repository.js";

/** Raw DeBank endpoints (the adapter's input) — implemented by the DeBank client. */
export interface DeBankRawSource {
  complexProtocolList(address: string): Promise<DeBankComplexProtocol[]>;
  allTokens(address: string): Promise<DeBankTokenBalance[]>;
  totalBalance(address: string): Promise<{ total_usd_value: number }>;
}

/** One EVM wallet of the account + its primary address. */
export interface EvmWalletRow {
  id: string;
  name: string;
  createdAt: Date;
  address: string;
}
export interface WalletAddressSource {
  evmWalletsForAccount(accountId: string): Promise<EvmWalletRow[]>;
}

export interface ShadowServiceLike {
  runForAccount(
    accountId: string,
    opts: {
      trigger: UcbShadowTrigger;
      liveByWalletId?: ReadonlyMap<string, LiveSnapshot>;
      cexCostBasisByHash?: ReadonlyMap<string, CexCostBasisMatch>;
      krystalV3ByTokenId?: ReadonlyMap<string, KrystalV3Summary>;
      krystalTxByTokenId?: ReadonlyMap<string, KrystalTransactionsSummary>;
    },
  ): Promise<RunShadowResult>;
}

/** B2: server-side CEX withdrawal cost basis for an account (by tx hash). */
export interface CexCostBasisSource {
  byHashForAccount(
    accountId: string,
  ): Promise<ReadonlyMap<string, CexCostBasisMatch>>;
}

/** B3: server-side Krystal V3 enrichment for an account. */
export interface KrystalV3SourceLike {
  forAccount(accountId: string): Promise<{
    krystalV3ByTokenId: ReadonlyMap<string, KrystalV3Summary>;
    krystalTxByTokenId: ReadonlyMap<string, KrystalTransactionsSummary>;
  }>;
}

export interface UcbShadowRunnerDeps {
  debank: DeBankRawSource;
  walletSource: WalletAddressSource;
  shadowService: ShadowServiceLike;
  flags: FlagResolver;
  /** B2 (optional): when present, CEX-origin positions inherit exchange cost basis. */
  cexSource?: CexCostBasisSource;
  /** B3 (optional): when present, covered V3 LP gets Krystal startUsd + matchedV3TokenId. */
  krystalSource?: KrystalV3SourceLike;
}

export class UcbShadowRunner {
  constructor(private readonly deps: UcbShadowRunnerDeps) {}

  /**
   * Build `liveByWalletId` from raw DeBank for every EVM wallet, then delegate
   * compute+store to the shadow service. Flag-gated up front (skip the DeBank
   * fetch when shadow is OFF). One DeBank fetch per wallet's primary address;
   * multi-address aggregation is a later refinement (testakk wallets are 1:1).
   */
  async run(
    accountId: string,
    trigger: UcbShadowTrigger = "refresh",
  ): Promise<RunShadowResult> {
    const on = await this.deps.flags.enabled(UCB_SERVER_SHADOW_FLAG, {
      accountId,
    });
    if (!on) return { skipped: true };

    // B2: CEX withdrawal cost basis (fail-soft — CEX errors must not block the
    // shadow; positions just won't inherit exchange cost basis).
    let cexCostBasisByHash: ReadonlyMap<string, CexCostBasisMatch> | undefined;
    if (this.deps.cexSource) {
      try {
        cexCostBasisByHash = await this.deps.cexSource.byHashForAccount(accountId);
      } catch {
        cexCostBasisByHash = undefined;
      }
    }

    // B3: Krystal V3 enrichment (fail-soft — Krystal outage must not block).
    let krystalV3ByTokenId: ReadonlyMap<string, KrystalV3Summary> | undefined;
    let krystalTxByTokenId:
      | ReadonlyMap<string, KrystalTransactionsSummary>
      | undefined;
    if (this.deps.krystalSource) {
      try {
        const k = await this.deps.krystalSource.forAccount(accountId);
        krystalV3ByTokenId = k.krystalV3ByTokenId;
        krystalTxByTokenId = k.krystalTxByTokenId;
      } catch {
        krystalV3ByTokenId = undefined;
        krystalTxByTokenId = undefined;
      }
    }

    const wallets = await this.deps.walletSource.evmWalletsForAccount(accountId);
    const liveByWalletId = new Map<string, LiveSnapshot>();
    for (const w of wallets) {
      const [protocols, tokens, total] = await Promise.all([
        this.deps.debank.complexProtocolList(w.address),
        this.deps.debank.allTokens(w.address),
        this.deps.debank.totalBalance(w.address),
      ]);
      const live = adaptDeBankLive({
        wallet: {
          id: w.id,
          name: w.name,
          address: w.address,
          chain: "evm",
          createdAt: w.createdAt.getTime(),
        },
        tokens,
        protocols,
        totalUsd: total.total_usd_value,
      });
      liveByWalletId.set(w.id, live);
    }
    return this.deps.shadowService.runForAccount(accountId, {
      trigger,
      liveByWalletId,
      ...(cexCostBasisByHash !== undefined && { cexCostBasisByHash }),
      ...(krystalV3ByTokenId !== undefined && { krystalV3ByTokenId }),
      ...(krystalTxByTokenId !== undefined && { krystalTxByTokenId }),
    });
  }
}
