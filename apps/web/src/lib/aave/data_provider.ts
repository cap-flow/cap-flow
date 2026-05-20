/**
 * Aave V3 Protocol Data Provider — чтение liquidation threshold (LT) per asset.
 *
 * Зачем: для multi-collateral позиций (POS-007: WETH+WBTC) per-asset цена
 * ликвидации зависит от LT каждого supply'а. Без точных LT'ов используем
 * uniform-LT приближение, что даёт 2-5% drift у активов с разными LT
 * (Aave WETH=83%, WBTC=78%, USDC=78%).
 *
 * Метод: `getReserveConfigurationData(asset)` возвращает (decimals, ltv,
 * liquidationThreshold, ...) где LT — в bps (8300 = 83%).
 *
 * Адреса AaveProtocolDataProvider per chain:
 *   • eth:   0x7B4EB56E7CD4b454BA8ff71E4518426369a138a3
 *   • arb:   0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654
 *   • op:    0xd9Ca4878dd38B021583c1B669905592EAe76E9e1
 *   • base:  0xd82a47fdebB5bf5329b09441C3DaB4b5df2153Ad
 *   • matic: 0x9441B65EE553F70df9C77d45d3283B6BC24F222d
 *   • avax:  0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654
 *
 * Источник: https://aave.com/docs/resources/addresses
 */

import {
  createPublicClient,
  http,
  type Address,
  type PublicClient,
} from "viem";
import {
  arbitrum,
  avalanche,
  base,
  mainnet,
  optimism,
  polygon,
} from "viem/chains";
import type { Chain } from "viem";

const PROTOCOL_DATA_PROVIDER: Record<
  string,
  { addr: `0x${string}`; chain: Chain; alchemySubdomain: string }
> = {
  eth: {
    addr: "0x7B4EB56E7CD4b454BA8ff71E4518426369a138a3",
    chain: mainnet,
    alchemySubdomain: "eth-mainnet",
  },
  arb: {
    addr: "0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654",
    chain: arbitrum,
    alchemySubdomain: "arb-mainnet",
  },
  op: {
    addr: "0xd9Ca4878dd38B021583c1B669905592EAe76E9e1",
    chain: optimism,
    alchemySubdomain: "opt-mainnet",
  },
  base: {
    addr: "0xd82a47fdebB5bf5329b09441C3DaB4b5df2153Ad",
    chain: base,
    alchemySubdomain: "base-mainnet",
  },
  matic: {
    addr: "0x9441B65EE553F70df9C77d45d3283B6BC24F222d",
    chain: polygon,
    alchemySubdomain: "polygon-mainnet",
  },
  avax: {
    addr: "0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654",
    chain: avalanche,
    alchemySubdomain: "avax-mainnet",
  },
};

const ABI = [
  {
    type: "function" as const,
    name: "getReserveConfigurationData",
    stateMutability: "view" as const,
    inputs: [{ name: "asset", type: "address" as const }],
    outputs: [
      { name: "decimals", type: "uint256" as const },
      { name: "ltv", type: "uint256" as const },
      { name: "liquidationThreshold", type: "uint256" as const },
      { name: "liquidationBonus", type: "uint256" as const },
      { name: "reserveFactor", type: "uint256" as const },
      { name: "usageAsCollateralEnabled", type: "bool" as const },
      { name: "borrowingEnabled", type: "bool" as const },
      { name: "stableBorrowRateEnabled", type: "bool" as const },
      { name: "isActive", type: "bool" as const },
      { name: "isFrozen", type: "bool" as const },
    ],
  },
] as const;

const CACHE_KEY = "capflow.cache.aave.reserveConfig.v1";
const CACHE_TTL_MS = 24 * 3600 * 1000; // 24h — LTs меняются редко (governance proposal)

interface CacheEntry {
  /** LT в долях (0.83 = 83%, для умножения на supply USD). */
  liquidationThreshold: number;
  /** LTV в долях. */
  ltv: number;
  /** Когда сохранили. */
  ts: number;
}

type Cache = Record<string, CacheEntry>;

function readCache(): Cache {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Cache;
  } catch {
    return {};
  }
}

function writeCache(c: Cache): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    /* quota — игнорируем */
  }
}

function cacheKey(chain: string, asset: string): string {
  return `${chain}|${asset.toLowerCase()}`;
}

function makeClient(chain: string, apiKey: string): PublicClient | null {
  const cfg = PROTOCOL_DATA_PROVIDER[chain];
  if (!cfg) return null;
  // S3.5: route through backend upstream-proxy; apiKey ignored.
  void apiKey;
  return createPublicClient({
    chain: cfg.chain,
    transport: http(`/api/v1/upstream/alchemy/${cfg.alchemySubdomain}`, {
      batch: true,
      fetchOptions: { credentials: "include" },
    }),
  });
}

export interface AaveReserveConfig {
  /** LT в долях (0.83 = 83%). */
  liquidationThreshold: number;
  /** LTV в долях (0.80 = 80%). */
  ltv: number;
}

/**
 * Прочитать LT/LTV конкретного asset'а на конкретном chain'е.
 * Кэш 24h в localStorage.
 */
export async function fetchAaveReserveConfig(
  chainCode: string,
  assetAddress: string,
  alchemyApiKey: string,
): Promise<AaveReserveConfig | null> {
  const cache = readCache();
  const ck = cacheKey(chainCode, assetAddress);
  const cached = cache[ck];
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return {
      liquidationThreshold: cached.liquidationThreshold,
      ltv: cached.ltv,
    };
  }
  const cfg = PROTOCOL_DATA_PROVIDER[chainCode];
  if (!cfg) return null;
  const client = makeClient(chainCode, alchemyApiKey);
  if (!client) return null;
  try {
    const result = (await client.readContract({
      address: cfg.addr,
      abi: ABI,
      functionName: "getReserveConfigurationData",
      args: [assetAddress as Address],
    })) as readonly [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      boolean,
      boolean,
      boolean,
      boolean,
      boolean,
    ];
    const ltv = Number(result[1]) / 10_000;
    const lt = Number(result[2]) / 10_000;
    cache[ck] = {
      liquidationThreshold: lt,
      ltv,
      ts: Date.now(),
    };
    writeCache(cache);
    return { liquidationThreshold: lt, ltv };
  } catch (e) {
    console.warn(
      `[Aave LT] fetch failed for ${chainCode}|${assetAddress}:`,
      (e as Error).message,
    );
    return null;
  }
}

/**
 * Bulk: для списка (chain, asset) запросов параллельно через
 * Promise.allSettled. Возвращает Map "chain|asset_lower" → AaveReserveConfig.
 */
export async function fetchAaveReserveConfigs(
  requests: { chainCode: string; assetAddress: string }[],
  alchemyApiKey: string,
  signal?: AbortSignal,
): Promise<Map<string, AaveReserveConfig>> {
  const out = new Map<string, AaveReserveConfig>();
  const results = await Promise.allSettled(
    requests.map(async (r) => {
      if (signal?.aborted) return null;
      const cfg = await fetchAaveReserveConfig(
        r.chainCode,
        r.assetAddress,
        alchemyApiKey,
      );
      if (cfg) {
        out.set(`${r.chainCode}|${r.assetAddress.toLowerCase()}`, cfg);
      }
      return cfg;
    }),
  );
  for (const r of results) {
    if (r.status === "rejected") {
      console.warn("[Aave LT] request rejected:", r.reason);
    }
  }
  return out;
}

export function aaveReserveConfigKey(chain: string, asset: string): string {
  return `${chain}|${asset.toLowerCase()}`;
}

// Note: aToken receipt addresses вынесены в `lib/lending/receipt_registry.ts`
// для multi-protocol audit'а (Aave V3, Spark, Compound V3, etc).
