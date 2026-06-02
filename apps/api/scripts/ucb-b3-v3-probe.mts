/**
 * B3-full diagnostic (one-off): verify the server V3 enrichment reproduces the
 * non-Krystal Velodrome gauge cost basis live. Targets MMaksimuk's wallet
 * (0x10b850c3…, Optimism) — the POS-011 Velodrome WETH/WBTC gauge-staked NFT
 * 3427934, golden startUsd $235.97 (slot0) / $237.80 (DefiLlama). Krystal does
 * NOT index this position → the on-chain V3 path is the only source.
 *
 * Run: cd apps/api && npx tsx --env-file=../../.env scripts/ucb-b3-v3-probe.mts
 */
import { UpstreamProxyService } from "../src/modules/upstream-proxy/upstream-proxy.service.js";
import { EtherscanClient } from "../src/modules/integrations/etherscan.js";
import { V3EnrichmentSource } from "../src/modules/ucb/v3-enrichment.source.js";
import { fetchHistoricalPrices } from "../src/modules/classifier/defillama_prices.js";

const WALLET = "0x10b850c3abfca78d693c9cd6fce809c129109d1c";
const VELODROME_NFT = "3427934"; // POS-011 WETH/WBTC gauge-staked

const upstreamProxy = new UpstreamProxyService({
  ETHERSCAN_API_KEY: process.env.ETHERSCAN_API_KEY,
  ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY,
});

const source = new V3EnrichmentSource({
  etherscan: new EtherscanClient(upstreamProxy),
  alchemyKey: process.env.ALCHEMY_API_KEY,
  fetchHistoricalPrices,
});

async function main() {
  console.log(`[v3-probe] enriching Velodrome V3 for ${WALLET} (op) …`);
  const positions = [{ protocol: { name: "Velodrome V3" }, chain: "op", walletId: "w" }];
  const walletAddressById = new Map([["w", WALLET]]);
  const { v3PositionMap, v3CostBasis } = await source.forPositions(positions, walletAddressById);

  console.log(`[v3-probe] v3PositionMap size = ${v3PositionMap.size}, v3CostBasis size = ${v3CostBasis.size}`);
  for (const [key, arr] of v3PositionMap) {
    for (const p of arr) {
      console.log(
        `  pos ${key.slice(0, 50)} NFT=${p.tokenId} ${p.token0.symbol}/${p.token1.symbol} ` +
          `pool=${p.poolAddress.slice(0, 10)} liq=${p.liquidity}`,
      );
    }
  }
  for (const [tokenId, cb] of v3CostBasis) {
    console.log(
      `  cb NFT=${tokenId}: netCostBasisUsd=$${cb.netCostBasisUsd.toFixed(2)} ` +
        `(dep0=${cb.totalDeposited0} dep1=${cb.totalDeposited1}, inc=${cb.eventCount.increase} dec=${cb.eventCount.decrease}, ` +
        `hist=${cb.hasHistPrices}, mint=${cb.mintTxHash?.slice(0, 12)})`,
    );
  }

  const target = v3CostBasis.get(VELODROME_NFT);
  if (target) {
    const ok = Math.abs(target.netCostBasisUsd - 235.97) <= 235.97 * 0.03; // ±3% (slot0 vs DefiLlama)
    console.log(
      `\n[v3-probe] POS-011 NFT ${VELODROME_NFT}: server $${target.netCostBasisUsd.toFixed(2)} vs golden $235.97 → ${ok ? "MATCH ✓" : "DIVERGE ✗"}`,
    );
  } else {
    console.log(`\n[v3-probe] NFT ${VELODROME_NFT} NOT in v3CostBasis — gauge discovery or events failed.`);
  }
}

main().catch((e) => {
  console.error("[v3-probe] FAILED:", e);
  process.exit(1);
});
