/**
 * B4 diagnostic (one-off): prove the server non-LP opener fetch path actually
 * fires live (not a silently-failing fail-soft no-op). Loads the latest stored
 * shadow positions for testakk, reconstructs walletAddressById, runs
 * NonLpOpenerSource.forPositions over the REAL Etherscan/Alchemy proxy, and
 * prints the resolved opener map + what applyNonLpOpenerOverride would change.
 *
 * Run: cd apps/api && npx tsx --env-file=../../.env scripts/ucb-b4-opener-probe.mts
 */
import { createDbClient } from "@cap-flow/db";

import { WalletsRepository } from "../src/modules/wallets/wallets.repository.js";
import { UcbShadowRepository } from "../src/modules/ucb/ucb-shadow.repository.js";
import { UpstreamProxyService } from "../src/modules/upstream-proxy/upstream-proxy.service.js";
import { EtherscanClient } from "../src/modules/integrations/etherscan.js";
import {
  AlchemyTransfersClient,
  isAlchemyChainSupported,
} from "../src/modules/integrations/alchemy-transfers.js";
import { NonLpOpenerSource } from "../src/modules/ucb/non-lp-opener.source.js";
import { fetchHistoricalPrices } from "../src/modules/classifier/defillama_prices.js";
import { applyNonLpOpenerOverride } from "@cap-flow/ucb/apply_opener_override";

const ACCOUNT_ID = "d96e847e-f030-47e5-82d6-8b0d5b2cf01f";

const dbClient = createDbClient({
  connectionString: process.env.DATABASE_URL ?? "",
  max: 2,
  idleTimeoutMillis: 10_000,
});

async function main() {
  const walletsRepo = new WalletsRepository(dbClient.db);
  const shadowRepo = new UcbShadowRepository(dbClient.db);

  const walletAddressById = new Map<string, string>();
  for (const w of await walletsRepo.listByAccount(ACCOUNT_ID)) {
    const evm = (await walletsRepo.listAddresses(w.id)).find((a) => a.type === "evm");
    if (evm) walletAddressById.set(w.id, evm.address);
  }

  const latest = await shadowRepo.findLatestForAccount(ACCOUNT_ID);
  if (!latest) {
    console.log("[probe] no shadow row — run acceptance first.");
    await dbClient.close();
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const positions = latest.positions as any[];

  const proxy = new UpstreamProxyService({
    DEBANK_API_KEY: process.env.DEBANK_API_KEY,
    HELIUS_API_KEY: process.env.HELIUS_API_KEY,
    ETHERSCAN_API_KEY: process.env.ETHERSCAN_API_KEY,
    ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY,
    KRYSTAL_API_KEY: process.env.KRYSTAL_API_KEY,
  });
  const source = new NonLpOpenerSource({
    etherscan: new EtherscanClient(proxy),
    alchemy: new AlchemyTransfersClient(proxy),
    fetchHistoricalPrices,
    isAlchemyChainSupported,
  });

  console.log(`[probe] resolving openers for ${positions.length} positions …`);
  const map = await source.forPositions(positions, walletAddressById);
  console.log(`[probe] opener map size = ${map.size} (0 = fetch silently failed / no targets!)`);
  for (const [k, op] of map) {
    console.log(
      `  ${k.slice(0, 60)}  openedAt=${op.openedAt}  startUsd=${op.startUsd}  ` +
        `out=[${op.openedInTokens.map((t) => `${t.symbol}:${t.amount}`).join(",")}]  ` +
        `netFrac=${op.receiptNetFraction}`,
    );
  }

  const res = applyNonLpOpenerOverride(positions, map, walletAddressById);
  console.log(`\n[probe] override overriddenCount = ${res.overriddenCount}`);
  for (const w of res.warnings) console.log("  " + w);

  await dbClient.close();
}

main().catch((e) => {
  console.error("[probe] FAILED:", e);
  process.exit(1);
});
