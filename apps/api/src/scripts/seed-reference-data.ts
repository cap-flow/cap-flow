/**
 * Seeds the global reference tables (chain_registry, coingecko_registry).
 *
 * Idempotent — uses ON CONFLICT DO UPDATE so re-running keeps data in sync
 * with the canonical list defined here.
 *
 * Run:
 *   set -a && . ./.env && set +a && \
 *     pnpm --filter @cap-flow/api exec tsx src/scripts/seed-reference-data.ts
 */
import { createDbClient, schema } from "@cap-flow/db";
import { sql } from "drizzle-orm";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
});

interface ChainSeed {
  chainId: number;
  name: string;
  feeToken: string;
  coingeckoPlatform: string | null;
}

/** EVM + L2 chains supported on launch (per SaaS decisions doc). */
const CHAINS: ChainSeed[] = [
  { chainId: 1, name: "Ethereum", feeToken: "ETH", coingeckoPlatform: "ethereum" },
  { chainId: 10, name: "Optimism", feeToken: "ETH", coingeckoPlatform: "optimistic-ethereum" },
  { chainId: 56, name: "BNB Smart Chain", feeToken: "BNB", coingeckoPlatform: "binance-smart-chain" },
  { chainId: 137, name: "Polygon", feeToken: "MATIC", coingeckoPlatform: "polygon-pos" },
  { chainId: 8453, name: "Base", feeToken: "ETH", coingeckoPlatform: "base" },
  { chainId: 42161, name: "Arbitrum One", feeToken: "ETH", coingeckoPlatform: "arbitrum-one" },
  { chainId: 43114, name: "Avalanche C-Chain", feeToken: "AVAX", coingeckoPlatform: "avalanche" },
];

interface TokenSeed {
  symbol: string;
  coingeckoId: string;
  name: string;
}

/** Top tokens by usage in Capflow's existing dataset + obvious must-haves.
 *  Symbol is uppercase; everything else lookup-friendly. */
const TOKENS: TokenSeed[] = [
  // Native
  { symbol: "ETH", coingeckoId: "ethereum", name: "Ethereum" },
  { symbol: "WETH", coingeckoId: "weth", name: "Wrapped Ether" },
  { symbol: "BTC", coingeckoId: "bitcoin", name: "Bitcoin" },
  { symbol: "WBTC", coingeckoId: "wrapped-bitcoin", name: "Wrapped Bitcoin" },
  { symbol: "BNB", coingeckoId: "binancecoin", name: "BNB" },
  { symbol: "MATIC", coingeckoId: "matic-network", name: "Polygon" },
  { symbol: "AVAX", coingeckoId: "avalanche-2", name: "Avalanche" },
  { symbol: "ARB", coingeckoId: "arbitrum", name: "Arbitrum" },
  { symbol: "OP", coingeckoId: "optimism", name: "Optimism" },
  // USD stables
  { symbol: "USDC", coingeckoId: "usd-coin", name: "USD Coin" },
  { symbol: "USDT", coingeckoId: "tether", name: "Tether" },
  { symbol: "DAI", coingeckoId: "dai", name: "Dai" },
  { symbol: "FRAX", coingeckoId: "frax", name: "Frax" },
  { symbol: "LUSD", coingeckoId: "liquity-usd", name: "Liquity USD" },
  { symbol: "USDE", coingeckoId: "ethena-usde", name: "Ethena USDe" },
  // EUR stables (DefiLlama, see capflow_v3_cost_basis memory)
  { symbol: "EURC", coingeckoId: "euro-coin", name: "Euro Coin" },
  { symbol: "EURS", coingeckoId: "stasis-eurs", name: "STASIS EURO" },
  // Liquid staking
  { symbol: "STETH", coingeckoId: "staked-ether", name: "Lido Staked Ether" },
  { symbol: "WSTETH", coingeckoId: "wrapped-steth", name: "Wrapped stETH" },
  { symbol: "RETH", coingeckoId: "rocket-pool-eth", name: "Rocket Pool ETH" },
  { symbol: "CBETH", coingeckoId: "coinbase-wrapped-staked-eth", name: "Coinbase Wrapped Staked ETH" },
  // Restaking
  { symbol: "EZETH", coingeckoId: "renzo-restaked-eth", name: "Renzo Restaked ETH" },
  { symbol: "WEETH", coingeckoId: "wrapped-eeth", name: "Wrapped eETH" },
  // DeFi blue chips
  { symbol: "AAVE", coingeckoId: "aave", name: "Aave" },
  { symbol: "UNI", coingeckoId: "uniswap", name: "Uniswap" },
  { symbol: "LINK", coingeckoId: "chainlink", name: "Chainlink" },
  { symbol: "CRV", coingeckoId: "curve-dao-token", name: "Curve DAO" },
  { symbol: "MKR", coingeckoId: "maker", name: "Maker" },
  { symbol: "LDO", coingeckoId: "lido-dao", name: "Lido DAO" },
  { symbol: "PENDLE", coingeckoId: "pendle", name: "Pendle" },
  { symbol: "GMX", coingeckoId: "gmx", name: "GMX" },
  // Memes & altcoins (popular in trading flow)
  { symbol: "SHIB", coingeckoId: "shiba-inu", name: "Shiba Inu" },
  { symbol: "PEPE", coingeckoId: "pepe", name: "Pepe" },
  { symbol: "DOGE", coingeckoId: "dogecoin", name: "Dogecoin" },
  // Other notable
  { symbol: "SOL", coingeckoId: "solana", name: "Solana" },
  { symbol: "ATOM", coingeckoId: "cosmos", name: "Cosmos Hub" },
];

async function main(): Promise<void> {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("[seed-reference] DATABASE_URL missing");
    process.exit(1);
  }
  const client = createDbClient({ connectionString: parsed.data.DATABASE_URL });

  try {
    console.log("[seed-reference] chains…");
    for (const c of CHAINS) {
      await client.db
        .insert(schema.chainRegistry)
        .values({
          chainId: c.chainId,
          name: c.name,
          feeToken: c.feeToken,
          coingeckoPlatform: c.coingeckoPlatform,
        })
        .onConflictDoUpdate({
          target: schema.chainRegistry.chainId,
          set: {
            name: c.name,
            feeToken: c.feeToken,
            coingeckoPlatform: c.coingeckoPlatform,
            updatedAt: sql`now()`,
          },
        });
    }
    console.log(`[seed-reference] ${CHAINS.length} chains upserted`);

    console.log("[seed-reference] tokens…");
    for (const t of TOKENS) {
      await client.db
        .insert(schema.coingeckoRegistry)
        .values({
          symbol: t.symbol,
          coingeckoId: t.coingeckoId,
          name: t.name,
        })
        .onConflictDoUpdate({
          target: schema.coingeckoRegistry.symbol,
          set: {
            coingeckoId: t.coingeckoId,
            name: t.name,
            updatedAt: sql`now()`,
          },
        });
    }
    console.log(`[seed-reference] ${TOKENS.length} tokens upserted`);

    console.log("[seed-reference] done.");
  } finally {
    await client.close();
  }
}

main().catch((err: unknown) => {
  console.error("[seed-reference] failed:", err);
  process.exit(1);
});
