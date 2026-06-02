/**
 * Server V3 deployment config (port of web `lib/v3/chains.ts`). Same deployment
 * identity (id/protocolMatch/chainCode) the override keys on, plus the fetch
 * config (viem chain / Alchemy subdomain / NPM / factory) for the server reads.
 *
 * Unlike the client (which routes viem through the upstream proxy + cap_access
 * cookie), the server talks DIRECTLY to Alchemy with the admin key
 * (`https://{subdomain}.g.alchemy.com/v2/{KEY}`).
 */
import type { Chain } from "viem";
import {
  arbitrum,
  avalanche,
  base,
  bsc,
  mainnet,
  optimism,
  polygon,
} from "viem/chains";

export interface V3Deployment {
  id: string;
  label: string;
  protocolMatch: RegExp;
  chainCode: string;
  chain: Chain;
  alchemySubdomain: string;
  npm: `0x${string}`;
  factory: `0x${string}`;
}

const UNI_V3_NPM = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88" as const;
const UNI_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984" as const;

const UNISWAP_V3: V3Deployment[] = [
  { id: "uniswap-v3-eth", label: "Uniswap V3", protocolMatch: /uniswap\s*v3/i, chainCode: "eth", chain: mainnet, alchemySubdomain: "eth-mainnet", npm: UNI_V3_NPM, factory: UNI_V3_FACTORY },
  { id: "uniswap-v3-arb", label: "Uniswap V3", protocolMatch: /uniswap\s*v3/i, chainCode: "arb", chain: arbitrum, alchemySubdomain: "arb-mainnet", npm: UNI_V3_NPM, factory: UNI_V3_FACTORY },
  { id: "uniswap-v3-op", label: "Uniswap V3", protocolMatch: /uniswap\s*v3/i, chainCode: "op", chain: optimism, alchemySubdomain: "opt-mainnet", npm: UNI_V3_NPM, factory: UNI_V3_FACTORY },
  { id: "uniswap-v3-matic", label: "Uniswap V3", protocolMatch: /uniswap\s*v3/i, chainCode: "matic", chain: polygon, alchemySubdomain: "polygon-mainnet", npm: UNI_V3_NPM, factory: UNI_V3_FACTORY },
  { id: "uniswap-v3-base", label: "Uniswap V3", protocolMatch: /uniswap\s*v3/i, chainCode: "base", chain: base, alchemySubdomain: "base-mainnet", npm: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1", factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" },
  { id: "uniswap-v3-bsc", label: "Uniswap V3", protocolMatch: /uniswap\s*v3/i, chainCode: "bsc", chain: bsc, alchemySubdomain: "bnb-mainnet", npm: "0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613", factory: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7" },
];

const PANCAKE_V3_NPM = "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364" as const;
const PANCAKE_V3_FACTORY = "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865" as const;

const PANCAKE_V3: V3Deployment[] = [
  { id: "pancake-v3-bsc", label: "PancakeSwap V3", protocolMatch: /pancake(swap)?\s*v3/i, chainCode: "bsc", chain: bsc, alchemySubdomain: "bnb-mainnet", npm: PANCAKE_V3_NPM, factory: PANCAKE_V3_FACTORY },
  { id: "pancake-v3-eth", label: "PancakeSwap V3", protocolMatch: /pancake(swap)?\s*v3/i, chainCode: "eth", chain: mainnet, alchemySubdomain: "eth-mainnet", npm: PANCAKE_V3_NPM, factory: PANCAKE_V3_FACTORY },
  { id: "pancake-v3-arb", label: "PancakeSwap V3", protocolMatch: /pancake(swap)?\s*v3/i, chainCode: "arb", chain: arbitrum, alchemySubdomain: "arb-mainnet", npm: PANCAKE_V3_NPM, factory: PANCAKE_V3_FACTORY },
  { id: "pancake-v3-base", label: "PancakeSwap V3", protocolMatch: /pancake(swap)?\s*v3/i, chainCode: "base", chain: base, alchemySubdomain: "base-mainnet", npm: PANCAKE_V3_NPM, factory: PANCAKE_V3_FACTORY },
];

const SUSHI_V3: V3Deployment[] = [
  { id: "sushi-v3-eth", label: "SushiSwap V3", protocolMatch: /sushi(swap)?\s*v3/i, chainCode: "eth", chain: mainnet, alchemySubdomain: "eth-mainnet", npm: "0x2214A42d8e2A1d20635c2cb0664422c528B6A432", factory: "0xbACEB8eC6b9355Dfc0269C18bac9d6E2Bdc29C4F" },
  { id: "sushi-v3-arb", label: "SushiSwap V3", protocolMatch: /sushi(swap)?\s*v3/i, chainCode: "arb", chain: arbitrum, alchemySubdomain: "arb-mainnet", npm: "0xb7402ee99F0A008e461098AC3A27F4957Df89a40", factory: "0x1af415a1EbA07a4986a52B6f2e7dE7003D82231e" },
  { id: "sushi-v3-op", label: "SushiSwap V3", protocolMatch: /sushi(swap)?\s*v3/i, chainCode: "op", chain: optimism, alchemySubdomain: "opt-mainnet", npm: "0x88FB8d9bdAa8eAcdA4F3d3e6f206E2C99e5fc14b", factory: "0x9c6522117e2ed1fE5bdb72bb0eD5E3f2bdE7DBe0" },
  { id: "sushi-v3-matic", label: "SushiSwap V3", protocolMatch: /sushi(swap)?\s*v3/i, chainCode: "matic", chain: polygon, alchemySubdomain: "polygon-mainnet", npm: "0xb7402ee99F0A008e461098AC3A27F4957Df89a40", factory: "0x917933899c6a5F8E37F31E19f92CdBFF7e8FF0e2" },
  { id: "sushi-v3-base", label: "SushiSwap V3", protocolMatch: /sushi(swap)?\s*v3/i, chainCode: "base", chain: base, alchemySubdomain: "base-mainnet", npm: "0x80C7DD17B01855a6D2347444a0FCC36136a314de", factory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4" },
  { id: "sushi-v3-bsc", label: "SushiSwap V3", protocolMatch: /sushi(swap)?\s*v3/i, chainCode: "bsc", chain: bsc, alchemySubdomain: "bnb-mainnet", npm: "0xF0cBce1942A68BEB3d1b73F0dd86C8DCc363eF49", factory: "0x126555dd55a39328F69400d6aE4F782Bd4C34ABb" },
  { id: "sushi-v3-avax", label: "SushiSwap V3", protocolMatch: /sushi(swap)?\s*v3/i, chainCode: "avax", chain: avalanche, alchemySubdomain: "avax-mainnet", npm: "0x18cb7889a9417e2ba305b9442226Ee0e2eb83AAC", factory: "0x3e603C14aF37EBdaD31709C4f848Fc6aD5BEc715" },
];

const VELODROME_V3: V3Deployment[] = [
  { id: "velodrome-v3-op", label: "Velodrome V3", protocolMatch: /velodrome(?:\s|-)*v3|velodrome(?:\s|-)*slipstream/i, chainCode: "op", chain: optimism, alchemySubdomain: "opt-mainnet", npm: "0x416b433906b1B72FA758e166e239c43d68dC6F29", factory: "0xCc0bDDB707055e04e497aB22a59c2aF4391cd12F" },
];

export const V3_DEPLOYMENTS: V3Deployment[] = [
  ...UNISWAP_V3,
  ...PANCAKE_V3,
  ...SUSHI_V3,
  ...VELODROME_V3,
];

/** All deployments matching (chainCode, protocolName). */
export function findV3Deployments(
  chainCode: string,
  protocolName: string,
): V3Deployment[] {
  return V3_DEPLOYMENTS.filter(
    (d) => d.chainCode === chainCode && d.protocolMatch.test(protocolName),
  );
}

/** Deployment ids for (chain, protocolName) — the override's resolveDeploymentIds. */
export function resolveV3DeploymentIds(
  chainCode: string,
  protocolName: string,
): string[] {
  return findV3Deployments(chainCode, protocolName).map((d) => d.id);
}

/** Velodrome/Aerodrome Slipstream → gauge-staked discovery + Slipstream ABIs. */
export function isGaugeBasedDeployment(dep: V3Deployment): boolean {
  return /velodrome|aerodrome/i.test(dep.id) || /velodrome|aerodrome/i.test(dep.label);
}

/** Direct Alchemy RPC URL with the admin key (server-side; no proxy/cookie). */
export function alchemyRpcUrl(dep: V3Deployment, apiKey: string): string {
  return `https://${dep.alchemySubdomain}.g.alchemy.com/v2/${apiKey}`;
}

/**
 * USD anchor pools per chain — the most-liquid V3 pool with a stable on one
 * side, so its slot0() gives a precise at-block oracle for volatile/volatile
 * pairs. Verified against Uniswap V3 deployments.
 */
export const USD_ANCHOR_POOLS: Record<
  string,
  {
    pool: `0x${string}`;
    stableSide: 0 | 1;
    stableDecimals: number;
    otherDecimals: number;
    otherSymbol: string;
    otherAddress: string;
  }
> = {
  arb: { pool: "0xC6962004f452bE9203591991D15f6b388e09E8D0", stableSide: 1, stableDecimals: 6, otherDecimals: 18, otherSymbol: "WETH", otherAddress: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1" },
  eth: { pool: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640", stableSide: 0, stableDecimals: 6, otherDecimals: 18, otherSymbol: "WETH", otherAddress: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" },
  op: { pool: "0x85149247691df622eaF1a8Bd0CaFd40BC45154a9", stableSide: 1, stableDecimals: 6, otherDecimals: 18, otherSymbol: "WETH", otherAddress: "0x4200000000000000000000000000000000000006" },
  base: { pool: "0xd0b53D9277642d899DF5C87A3966A349A798F224", stableSide: 1, stableDecimals: 6, otherDecimals: 18, otherSymbol: "WETH", otherAddress: "0x4200000000000000000000000000000000000006" },
  matic: { pool: "0xA374094527e1673A86dE625aa59517c5dE346d32", stableSide: 1, stableDecimals: 6, otherDecimals: 18, otherSymbol: "WMATIC", otherAddress: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270" },
};
