/**
 * Single-source wiring for the UCB shadow runner stack (the full enrichment
 * pipeline: CEX + Krystal + non-Krystal V3 + non-LP opener). Used by the worker
 * (production refresh path), the admin debug route, and the local test scripts so
 * the composition never drifts across them.
 */
import type { Database } from "@cap-flow/db";
import type { LotMethodology } from "@cap-flow/ucb/lots/types";
import type { CexCostBasisMatch } from "@cap-flow/ucb/position_coverage";

import { DeBankClient } from "../integrations/debank.js";
import { WalletsRepository } from "../wallets/wallets.repository.js";
import { AccountsRepository } from "../accounts/accounts.repository.js";
import { AuditService } from "../audit/audit.service.js";
import { AuditRepository } from "../audit/audit.repository.js";
import { CexRepository } from "../cex/cex.repository.js";
import { CexCostBasisService } from "../cex/cex.cost-basis.service.js";
import { HistoricalFxService } from "../cex/historical-fx.service.js";
import { DepositSeedsRepository } from "../cex/deposit-seeds.repository.js";
import { DepositSeedsService } from "../cex/deposit-seeds.service.js";
import { UpstreamProxyService } from "../upstream-proxy/upstream-proxy.service.js";
import { KrystalClient } from "../integrations/krystal.js";
import { EtherscanClient } from "../integrations/etherscan.js";
import {
  AlchemyTransfersClient,
  isAlchemyChainSupported,
} from "../integrations/alchemy-transfers.js";
import { fetchHistoricalPrices } from "../classifier/defillama_prices.js";

import { KrystalV3Source } from "./krystal-v3.source.js";
import { NonLpOpenerSource } from "./non-lp-opener.source.js";
import { V3EnrichmentSource } from "./v3-enrichment.source.js";
import { OpPricingService } from "./op-pricing.service.js";
import { OpPricingRepository } from "./op-pricing.repository.js";
import { UcbOpsRepository } from "./ucb-ops.repository.js";
import { UcbShadowRepository } from "./ucb-shadow.repository.js";
import { UcbShadowService, type FlagResolver } from "./ucb-shadow.service.js";
import {
  UcbShadowRunner,
  type CexCostBasisSource,
  type DeBankRawSource,
  type EvmWalletRow,
  type WalletAddressSource,
} from "./ucb-shadow-runner.js";
import type {
  DeBankComplexProtocol,
  DeBankTokenBalance,
} from "./debank-live.adapter.js";

export interface UcbStackEnv {
  DEBANK_API_KEY?: string | undefined;
  HELIUS_API_KEY?: string | undefined;
  ETHERSCAN_API_KEY?: string | undefined;
  ALCHEMY_API_KEY?: string | undefined;
  KRYSTAL_API_KEY?: string | undefined;
}

export interface UcbRunnerStackDeps {
  db: Database;
  env: UcbStackEnv;
  debankClient: DeBankClient;
  walletsRepo: WalletsRepository;
  accountsRepo: AccountsRepository;
  audit: AuditService;
  /** Flag gate. Worker passes the real feature-flags service; debug/test pass always-on. */
  flags: FlagResolver;
  engineVersion: string;
  lotMethodology?: LotMethodology;
}

export interface UcbRunnerStack {
  runner: UcbShadowRunner;
  shadowService: UcbShadowService;
  shadowRepo: UcbShadowRepository;
  opsRepo: UcbOpsRepository;
  opPricingService: OpPricingService;
}

export function buildUcbRunnerStack(deps: UcbRunnerStackDeps): UcbRunnerStack {
  const { db, env, debankClient, walletsRepo, accountsRepo, audit, flags } = deps;

  const upstreamProxy = new UpstreamProxyService({
    DEBANK_API_KEY: env.DEBANK_API_KEY,
    HELIUS_API_KEY: env.HELIUS_API_KEY,
    ETHERSCAN_API_KEY: env.ETHERSCAN_API_KEY,
    ALCHEMY_API_KEY: env.ALCHEMY_API_KEY,
    KRYSTAL_API_KEY: env.KRYSTAL_API_KEY,
  });

  const opsRepo = new UcbOpsRepository(db);
  const shadowRepo = new UcbShadowRepository(db);
  const opPricingService = new OpPricingService(new OpPricingRepository(db));

  const shadowService = new UcbShadowService({
    opsRepo,
    shadowRepo,
    opPricingService,
    flags,
    engineVersion: deps.engineVersion,
    ...(deps.lotMethodology !== undefined && { lotMethodology: deps.lotMethodology }),
    nonLpOpenerSource: new NonLpOpenerSource({
      etherscan: new EtherscanClient(upstreamProxy),
      alchemy: new AlchemyTransfersClient(upstreamProxy),
      fetchHistoricalPrices,
      isAlchemyChainSupported,
    }),
    v3EnrichmentSource: new V3EnrichmentSource({
      etherscan: new EtherscanClient(upstreamProxy),
      alchemyKey: env.ALCHEMY_API_KEY,
      fetchHistoricalPrices,
    }),
  });

  const debankSource: DeBankRawSource = {
    complexProtocolList: async (addr) =>
      (await debankClient.getRawComplexProtocols(addr)) as unknown as DeBankComplexProtocol[],
    allTokens: async (addr) =>
      (await debankClient.getRawTokenList(addr)) as unknown as DeBankTokenBalance[],
    totalBalance: async (addr) => ({
      total_usd_value: (await debankClient.getTotalBalance(addr)).totalUsdValue,
    }),
  };

  const walletSource: WalletAddressSource = {
    evmWalletsForAccount: async (accountId) => {
      const out: EvmWalletRow[] = [];
      for (const w of await walletsRepo.listByAccount(accountId)) {
        const evm = (await walletsRepo.listAddresses(w.id)).find((a) => a.type === "evm");
        if (evm) out.push({ id: w.id, name: w.name, createdAt: w.createdAt, address: evm.address });
      }
      return out;
    },
  };

  const cexCostBasis = new CexCostBasisService(
    new CexRepository(db),
    new HistoricalFxService(db),
    new DepositSeedsService(new DepositSeedsRepository(db), audit),
  );
  const cexSource: CexCostBasisSource = {
    byHashForAccount: async (accountId) => {
      const m = new Map<string, CexCostBasisMatch>();
      const account = await accountsRepo.findById(accountId);
      if (!account) return m;
      for (const c of await cexCostBasis.computeForUser(account.ownerId)) {
        m.set(c.txHash.toLowerCase(), { costBasisUsd: c.costBasisUsd, source: c.source, asset: c.asset });
      }
      return m;
    },
  };

  const krystalSource = new KrystalV3Source({
    client: new KrystalClient(upstreamProxy),
    walletSource,
  });

  const runner = new UcbShadowRunner({
    debank: debankSource,
    walletSource,
    shadowService,
    flags,
    cexSource,
    krystalSource,
  });

  return { runner, shadowService, shadowRepo, opsRepo, opPricingService };
}

/** Convenience for scripts/admin: build deps that need only a db + env + debank key. */
export function buildUcbRunnerStackFromDb(
  db: Database,
  env: UcbStackEnv,
  opts: { flags: FlagResolver; engineVersion: string; lotMethodology?: LotMethodology },
): UcbRunnerStack {
  return buildUcbRunnerStack({
    db,
    env,
    debankClient: new DeBankClient(env.DEBANK_API_KEY),
    walletsRepo: new WalletsRepository(db),
    accountsRepo: new AccountsRepository(db),
    audit: new AuditService(new AuditRepository(db)),
    flags: opts.flags,
    engineVersion: opts.engineVersion,
    ...(opts.lotMethodology !== undefined && { lotMethodology: opts.lotMethodology }),
  });
}
