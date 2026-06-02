/**
 * B5 RUNTIME ACCEPTANCE (one-off). Runs the wired shadow path end-to-end against
 * the real DB + live DeBank for the testakk account — the exact thing the worker
 * does after refresh — then compares the server-stored startUsd against the
 * client-verified golden anchors. Bypasses BullMQ/Redis via a direct
 * UcbShadowRunner call. Flag forced ON (the flag mechanism is unit-tested).
 *
 * Run:  cd apps/api && npx tsx --env-file=../../.env scripts/ucb-shadow-acceptance.mts
 */
import { readFileSync } from "node:fs";

import { createDbClient } from "@cap-flow/db";

import { DeBankClient } from "../src/modules/integrations/debank.js";
import { WalletsRepository } from "../src/modules/wallets/wallets.repository.js";
import { AccountsRepository } from "../src/modules/accounts/accounts.repository.js";
import { AuditRepository } from "../src/modules/audit/audit.repository.js";
import { AuditService } from "../src/modules/audit/audit.service.js";
import { CexRepository } from "../src/modules/cex/cex.repository.js";
import { CexCostBasisService } from "../src/modules/cex/cex.cost-basis.service.js";
import { HistoricalFxService } from "../src/modules/cex/historical-fx.service.js";
import { DepositSeedsRepository } from "../src/modules/cex/deposit-seeds.repository.js";
import { DepositSeedsService } from "../src/modules/cex/deposit-seeds.service.js";
import type { CexCostBasisMatch } from "@cap-flow/ucb/position_coverage";
import { UpstreamProxyService } from "../src/modules/upstream-proxy/upstream-proxy.service.js";
import { KrystalClient } from "../src/modules/integrations/krystal.js";
import { KrystalV3Source } from "../src/modules/ucb/krystal-v3.source.js";
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

const ACCOUNT_ID = "d96e847e-f030-47e5-82d6-8b0d5b2cf01f"; // testakk
const alwaysOn = { enabled: async () => true };

const dbClient = createDbClient({
  connectionString: process.env.DATABASE_URL ?? "",
  max: 4,
  idleTimeoutMillis: 10_000,
});
const debankClient = new DeBankClient(process.env.DEBANK_API_KEY);
const walletsRepo = new WalletsRepository(dbClient.db);
const shadowRepo = new UcbShadowRepository(dbClient.db);

const shadowService = new UcbShadowService({
  opsRepo: new UcbOpsRepository(dbClient.db),
  shadowRepo,
  opPricingService: new OpPricingService(new OpPricingRepository(dbClient.db)),
  flags: alwaysOn,
  engineVersion: "acceptance-run",
  // The golden anchors (artur-1/murat-1) were captured with the client's
  // FIFO/LIFO/WAC toggle on LIFO, so the shadow run must compute under LIFO to
  // reproduce them apples-to-apples (task #18). Production per-user methodology
  // persistence is a B6 concern.
  lotMethodology: "LIFO",
});
const debankSource: DeBankRawSource = {
  complexProtocolList: async (a) =>
    (await debankClient.getRawComplexProtocols(a)) as unknown as DeBankComplexProtocol[],
  allTokens: async (a) =>
    (await debankClient.getRawTokenList(a)) as unknown as DeBankTokenBalance[],
  totalBalance: async (a) => ({
    total_usd_value: (await debankClient.getTotalBalance(a)).totalUsdValue,
  }),
};
const walletSource: WalletAddressSource = {
  evmWalletsForAccount: async (acc) => {
    const out: EvmWalletRow[] = [];
    for (const w of await walletsRepo.listByAccount(acc)) {
      const evm = (await walletsRepo.listAddresses(w.id)).find(
        (x) => x.type === "evm",
      );
      if (evm)
        out.push({ id: w.id, name: w.name, createdAt: w.createdAt, address: evm.address });
    }
    return out;
  },
};
// B2: real server-side CEX cost basis (full service, like the client endpoint).
const auditSvc = new AuditService(new AuditRepository(dbClient.db));
const cexCostBasisSvc = new CexCostBasisService(
  new CexRepository(dbClient.db),
  new HistoricalFxService(dbClient.db),
  new DepositSeedsService(new DepositSeedsRepository(dbClient.db), auditSvc),
);
const accountsRepo = new AccountsRepository(dbClient.db);
const cexSource: CexCostBasisSource = {
  byHashForAccount: async (accountId) => {
    const m = new Map<string, CexCostBasisMatch>();
    const account = await accountsRepo.findById(accountId);
    if (!account) return m;
    for (const c of await cexCostBasisSvc.computeForUser(account.ownerId)) {
      m.set(c.txHash.toLowerCase(), {
        costBasisUsd: c.costBasisUsd,
        source: c.source,
        asset: c.asset,
      });
    }
    return m;
  },
};
// B3: real Krystal V3 enrichment over the upstream proxy.
const upstreamProxy = new UpstreamProxyService({
  DEBANK_API_KEY: process.env.DEBANK_API_KEY,
  HELIUS_API_KEY: process.env.HELIUS_API_KEY,
  ETHERSCAN_API_KEY: process.env.ETHERSCAN_API_KEY,
  ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY,
  KRYSTAL_API_KEY: process.env.KRYSTAL_API_KEY,
});
const krystalSource = new KrystalV3Source({
  client: new KrystalClient(upstreamProxy),
  walletSource,
});
const runner = new UcbShadowRunner({
  debank: debankSource,
  walletSource,
  shadowService,
  flags: alwaysOn,
  cexSource,
  krystalSource,
});

// ── load client golden anchors (the verified client values) ──
type Anchor = { label: string; anchor: { chain: string; protocolId: string; marketKey: string | null; tokenId?: string | null; supplySymbol?: string }; expected: { startUsd: number; tolerancePct?: number; toleranceAbsUsd?: number } };
const FX = "src/lib/portfolio/__fixtures__/golden"; // not present in api; use web copy
function loadAnchors(): Anchor[] {
  const base =
    "/Users/vladimir/Desktop/cap-flow (для блокчейна)/.claude/worktrees/condescending-fermi-99f0ac/apps/web/src/lib/portfolio/__fixtures__/golden";
  const out: Anchor[] = [];
  for (const f of ["artur-1.json", "murat-1.json"]) {
    const fx = JSON.parse(readFileSync(`${base}/${f}`, "utf8"));
    for (const a of fx.anchors ?? []) out.push(a);
  }
  return out;
}

function matchPos(
  positions: { chain: string; protocol: { id: string }; lpTokenId: string | null; matchedV3TokenId: string | null; supplyTokens: { symbol: string }[]; startUsd: number }[],
  a: Anchor,
) {
  return positions.find((p) => {
    if (p.chain !== a.anchor.chain || p.protocol.id !== a.anchor.protocolId) return false;
    if (a.anchor.tokenId) return p.matchedV3TokenId === a.anchor.tokenId;
    if (p.lpTokenId !== a.anchor.marketKey) return false;
    if (a.anchor.supplySymbol) return p.supplyTokens[0]?.symbol === a.anchor.supplySymbol;
    return true;
  });
}

async function main() {
  console.log(`[acceptance] running shadow for testakk ${ACCOUNT_ID} …`);
  const result = await runner.run(ACCOUNT_ID, "manual");
  console.log("[acceptance] runner result:", JSON.stringify(result));

  const latest = await shadowRepo.findLatestForAccount(ACCOUNT_ID);
  if (!latest) {
    console.log("[acceptance] NO shadow row stored — check flag/wallets/ops.");
    await dbClient.close();
    return;
  }
  console.log(
    `[acceptance] STORED ${latest.positions.length} positions (engine ${latest.engineVersion}, trigger ${latest.trigger}):`,
  );
  for (const p of latest.positions as any[]) {
    console.log(
      `  ${p.protocol.id.padEnd(14)} ${(p.lpTokenId ?? "").slice(0, 12).padEnd(12)} ${(p.supplyTokens?.[0]?.symbol ?? "").padEnd(6)} v3=${p.matchedV3TokenId ?? "-"}  start=$${Math.round((p.startUsd ?? 0) * 100) / 100}`,
    );
  }

  console.log("\n[acceptance] SERVER vs CLIENT (golden anchors):");
  const anchors = loadAnchors();
  let matched = 0, diverged = 0, missing = 0;
  for (const a of anchors) {
    const p = matchPos(latest.positions as any[], a);
    if (!p) { console.log(`  MISSING  ${a.label} (expected $${a.expected.startUsd})`); missing++; continue; }
    const exp = a.expected.startUsd;
    const got = p.startUsd;
    const pct = exp ? Math.abs(got - exp) / Math.abs(exp) : 0;
    const tol = Math.max(a.expected.toleranceAbsUsd ?? 1, exp * (a.expected.tolerancePct ?? 0.005));
    const ok = Math.abs(got - exp) <= tol;
    console.log(`  ${ok ? "MATCH  " : "DIVERGE"} ${a.label}: server $${Math.round(got * 100) / 100} vs client $${exp} (${(pct * 100).toFixed(1)}%)`);
    if (ok) matched++; else diverged++;
  }
  console.log(`\n[acceptance] SUMMARY: ${matched} match, ${diverged} diverge, ${missing} missing (of ${anchors.length} anchors).`);
  await dbClient.close();
}

main().catch((e) => {
  console.error("[acceptance] FAILED:", e);
  process.exit(1);
});
