/**
 * Local server-UCB test harness — compute the canonical positions for ANY wallet
 * the way the worker does (full enrichment: CEX + Krystal + non-Krystal V3 +
 * non-LP opener), warm the op-price cache first, store to ucb_shadow_results, and
 * print a readable positions table to eyeball against the client UI.
 *
 * Run:
 *   cd apps/api
 *   npx tsx --env-file=../../.env scripts/ucb-compute.mts <accountId | email> [--lifo|--wac|--fifo]
 *
 * Examples:
 *   … scripts/ucb-compute.mts bob@example.com
 *   … scripts/ucb-compute.mts d96e847e-f030-47e5-82d6-8b0d5b2cf01f --lifo
 */
import { createDbClient } from "@cap-flow/db";

import { DeBankClient } from "../src/modules/integrations/debank.js";
import { WalletsRepository } from "../src/modules/wallets/wallets.repository.js";
import { AccountsRepository } from "../src/modules/accounts/accounts.repository.js";
import { AuthRepository } from "../src/modules/auth/auth.repository.js";
import { AuditRepository } from "../src/modules/audit/audit.repository.js";
import { AuditService } from "../src/modules/audit/audit.service.js";
import { CexRepository } from "../src/modules/cex/cex.repository.js";
import { CexCostBasisService } from "../src/modules/cex/cex.cost-basis.service.js";
import { HistoricalFxService } from "../src/modules/cex/historical-fx.service.js";
import { DepositSeedsRepository } from "../src/modules/cex/deposit-seeds.repository.js";
import { DepositSeedsService } from "../src/modules/cex/deposit-seeds.service.js";
import type { CexCostBasisMatch } from "@cap-flow/ucb/position_coverage";
import type { LotMethodology } from "@cap-flow/ucb/lots/types";
import { UpstreamProxyService } from "../src/modules/upstream-proxy/upstream-proxy.service.js";
import { KrystalClient } from "../src/modules/integrations/krystal.js";
import { KrystalV3Source } from "../src/modules/ucb/krystal-v3.source.js";
import { EtherscanClient } from "../src/modules/integrations/etherscan.js";
import {
  AlchemyTransfersClient,
  isAlchemyChainSupported,
} from "../src/modules/integrations/alchemy-transfers.js";
import { NonLpOpenerSource } from "../src/modules/ucb/non-lp-opener.source.js";
import { V3EnrichmentSource } from "../src/modules/ucb/v3-enrichment.source.js";
import { fetchHistoricalPrices } from "../src/modules/classifier/defillama_prices.js";
import { OpPricingService } from "../src/modules/ucb/op-pricing.service.js";
import { OpPricingRepository } from "../src/modules/ucb/op-pricing.repository.js";
import { UcbOpsRepository } from "../src/modules/ucb/ucb-ops.repository.js";
import { UcbShadowRepository } from "../src/modules/ucb/ucb-shadow.repository.js";
import { UcbShadowService } from "../src/modules/ucb/ucb-shadow.service.js";
import {
  UcbShadowRunner,
  type CexCostBasisSource,
  type DeBankRawSource,
  type EvmWalletRow,
  type WalletAddressSource,
} from "../src/modules/ucb/ucb-shadow-runner.js";
import type {
  DeBankComplexProtocol,
  DeBankTokenBalance,
} from "../src/modules/ucb/debank-live.adapter.js";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: ucb-compute.mts <accountId | email> [--lifo|--wac|--fifo]");
  process.exit(1);
}
const flag = process.argv.find((a) => a.startsWith("--"));
const methodology: LotMethodology =
  flag === "--lifo" ? "LIFO" : flag === "--wac" ? "WAC" : flag === "--hifo" ? "HIFO" : "FIFO";

const dbClient = createDbClient({
  connectionString: process.env.DATABASE_URL ?? "",
  max: 4,
  idleTimeoutMillis: 10_000,
});
const debankClient = new DeBankClient(process.env.DEBANK_API_KEY);
const walletsRepo = new WalletsRepository(dbClient.db);
const accountsRepo = new AccountsRepository(dbClient.db);
const authRepo = new AuthRepository(dbClient.db);
const shadowRepo = new UcbShadowRepository(dbClient.db);
const opsRepo = new UcbOpsRepository(dbClient.db);
const opPricingService = new OpPricingService(new OpPricingRepository(dbClient.db));

const alwaysOn = { enabled: async () => true };

async function resolveAccountIds(): Promise<{ id: string; label: string }[]> {
  // uuid → that account; else treat as email → owner's active accounts.
  if (/^[0-9a-f-]{36}$/i.test(arg!)) {
    const a = await accountsRepo.findById(arg!);
    return a ? [{ id: a.id, label: `account ${a.id.slice(0, 8)}` }] : [];
  }
  const user = await authRepo.findUserByEmail(arg!);
  if (!user) return [];
  const accs = await accountsRepo.findActiveByOwner(user.id);
  return accs.map((a) => ({ id: a.id, label: `${arg} / account ${a.id.slice(0, 8)}` }));
}

function buildRunner() {
  const upstreamProxy = new UpstreamProxyService({
    DEBANK_API_KEY: process.env.DEBANK_API_KEY,
    HELIUS_API_KEY: process.env.HELIUS_API_KEY,
    ETHERSCAN_API_KEY: process.env.ETHERSCAN_API_KEY,
    ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY,
    KRYSTAL_API_KEY: process.env.KRYSTAL_API_KEY,
  });
  const walletSource: WalletAddressSource = {
    evmWalletsForAccount: async (acc) => {
      const out: EvmWalletRow[] = [];
      for (const w of await walletsRepo.listByAccount(acc)) {
        const evm = (await walletsRepo.listAddresses(w.id)).find((x) => x.type === "evm");
        if (evm) out.push({ id: w.id, name: w.name, createdAt: w.createdAt, address: evm.address });
      }
      return out;
    },
  };
  const debankSource: DeBankRawSource = {
    complexProtocolList: async (a) =>
      (await debankClient.getRawComplexProtocols(a)) as unknown as DeBankComplexProtocol[],
    allTokens: async (a) => (await debankClient.getRawTokenList(a)) as unknown as DeBankTokenBalance[],
    totalBalance: async (a) => ({ total_usd_value: (await debankClient.getTotalBalance(a)).totalUsdValue }),
  };
  const auditSvc = new AuditService(new AuditRepository(dbClient.db));
  const cexCostBasisSvc = new CexCostBasisService(
    new CexRepository(dbClient.db),
    new HistoricalFxService(dbClient.db),
    new DepositSeedsService(new DepositSeedsRepository(dbClient.db), auditSvc),
  );
  const cexSource: CexCostBasisSource = {
    byHashForAccount: async (accountId) => {
      const m = new Map<string, CexCostBasisMatch>();
      const account = await accountsRepo.findById(accountId);
      if (!account) return m;
      for (const c of await cexCostBasisSvc.computeForUser(account.ownerId)) {
        m.set(c.txHash.toLowerCase(), { costBasisUsd: c.costBasisUsd, source: c.source, asset: c.asset });
      }
      return m;
    },
  };
  const shadowService = new UcbShadowService({
    opsRepo,
    shadowRepo,
    opPricingService,
    flags: alwaysOn,
    engineVersion: "local-compute",
    lotMethodology: methodology,
    nonLpOpenerSource: new NonLpOpenerSource({
      etherscan: new EtherscanClient(upstreamProxy),
      alchemy: new AlchemyTransfersClient(upstreamProxy),
      fetchHistoricalPrices,
      isAlchemyChainSupported,
    }),
    v3EnrichmentSource: new V3EnrichmentSource({
      etherscan: new EtherscanClient(upstreamProxy),
      alchemyKey: process.env.ALCHEMY_API_KEY,
      fetchHistoricalPrices,
    }),
  });
  return new UcbShadowRunner({
    debank: debankSource,
    walletSource,
    shadowService,
    flags: alwaysOn,
    cexSource,
    krystalSource: new KrystalV3Source({ client: new KrystalClient(upstreamProxy), walletSource }),
  });
}

async function warmPriceCache(accountId: string): Promise<void> {
  // The runner reads the op-price cache but doesn't fill it; warm it so the
  // server cost basis uses block-fixed prices (else it diverges from the client).
  const wallets = await opsRepo.loadComputeWalletsForAccount(accountId);
  const ops = wallets.flatMap((w) => w.ops);
  const { missing } = await opPricingService.priceMapForOps(ops);
  if (missing.length > 0) {
    const filled = await opPricingService.fillMissing(missing);
    console.log(`  [price cache] ${ops.length} ops, ${missing.length} missing → ${filled.written} filled`);
  } else {
    console.log(`  [price cache] ${ops.length} ops, cache warm (0 missing)`);
  }
}

function fmt(n: number | null | undefined): string {
  return n == null ? "—" : `$${(Math.round(n * 100) / 100).toLocaleString("en-US")}`;
}

async function main() {
  const accounts = await resolveAccountIds();
  if (accounts.length === 0) {
    console.error(`No account/user found for "${arg}".`);
    await dbClient.close();
    process.exit(1);
  }
  const runner = buildRunner();
  console.log(`[ucb-compute] methodology=${methodology}, ${accounts.length} account(s)\n`);

  for (const { id, label } of accounts) {
    console.log(`━━ ${label} ━━`);
    await warmPriceCache(id);
    const res = await runner.run(id, "manual");
    if (res.error) {
      console.log(`  ⚠ compute error: ${res.error}\n`);
      continue;
    }
    const latest = await shadowRepo.findLatestForAccount(id);
    if (!latest) {
      console.log(`  no positions stored (no EVM wallets / no live data?)\n`);
      continue;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const positions = latest.positions as any[];
    console.log(`  ${positions.length} positions:\n`);
    console.log(
      "  " +
        ["#", "protocol", "chain", "symbol", "v3", "startUsd", "currentUsd", "PnL", "fees", "flags"]
          .map((h, i) => h.padEnd([4, 16, 6, 8, 9, 12, 12, 11, 9, 6][i]))
          .join(""),
    );
    positions.forEach((p, i) => {
      const sym = p.supplyTokens?.map((t: any) => t.symbol).join("+") ?? "";
      const cols = [
        String(i + 1).padEnd(4),
        String(p.protocol?.id ?? p.protocol?.name ?? "").slice(0, 15).padEnd(16),
        String(p.chain ?? "").padEnd(6),
        sym.slice(0, 7).padEnd(8),
        String(p.matchedV3TokenId ?? "-").slice(0, 8).padEnd(9),
        fmt(p.startUsd).padEnd(12),
        fmt(p.currentUsd).padEnd(12),
        fmt(p.netPnlUsd).padEnd(11),
        fmt(p.feesUsd).padEnd(9),
        (p.coverageIncomplete ? "⚠inc" : "").padEnd(6),
      ];
      console.log("  " + cols.join(""));
    });
    console.log("");
  }
  await dbClient.close();
}

main().catch((e) => {
  console.error("[ucb-compute] FAILED:", e);
  process.exit(1);
});
