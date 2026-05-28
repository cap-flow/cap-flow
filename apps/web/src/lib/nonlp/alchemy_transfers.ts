/**
 * Alchemy fallback для non-LP opener detection на chains, которые Etherscan
 * free tier не поддерживает (BASE, Avalanche, ...).
 *
 * Etherscan free возвращает `EtherscanChainNotSupportedError` для base/avax →
 * здесь используем Alchemy `alchemy_getAssetTransfers` (через backend
 * upstream-proxy `/api/v1/upstream/alchemy/{subdomain}`, admin-key инжектится
 * server-side).
 *
 * 2026-05-28 (Stage 1b MMaksimuk no-date audit): подтверждено через Alchemy
 * MCP — LAGOON ($310) на avax: receipt `turtleAvalancheUSDC` minted from 0x0
 * на блоке 0x43325f2 → timestamp 17.10.2025.
 *
 * NB: `withMetadata` (timestamps в getAssetTransfers) Alchemy отдаёт только
 * для ETH/Base/Polygon/Arbitrum/Optimism — НЕ для Avalanche. Поэтому
 * timestamp matched-блока резолвим отдельно через `eth_getBlockByNumber`.
 */

import { apiFetch } from "../api/client";

/** chainCode → Alchemy subdomain (как в upstream-proxy ALCHEMY_CHAINS). */
const CHAIN_TO_SUBDOMAIN: Record<string, string> = {
  eth: "eth-mainnet",
  arb: "arb-mainnet",
  op: "opt-mainnet",
  matic: "polygon-mainnet",
  base: "base-mainnet",
  bsc: "bnb-mainnet",
  avax: "avax-mainnet",
};

export interface AlchemyTransfer {
  blockNumber: number;
  hash: string;
  from: string; // lowercase
  to: string; // lowercase
  contractAddress: string; // lowercase
}

async function alchemyRpc(
  chainCode: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const sub = CHAIN_TO_SUBDOMAIN[chainCode.toLowerCase()];
  if (!sub) throw new Error(`Alchemy: unknown chain ${chainCode}`);
  // apiFetch сам делает JSON.stringify(opts.body) — передаём СЫРОЙ объект,
  // иначе double-stringify → proxy получит строку вместо JSON-RPC объекта.
  const res = await apiFetch(`/v1/upstream/alchemy/${sub}`, {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1, method, params },
  });
  if (!res.ok) {
    throw new Error(`Alchemy HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  }
  const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (json.error) throw new Error(`Alchemy RPC: ${json.error.message ?? "unknown"}`);
  return json.result;
}

interface RawAssetTransfer {
  blockNum: string;
  hash?: string;
  from: string;
  to: string | null;
  rawContract?: { address?: string | null };
}

function mapTransfers(result: unknown): AlchemyTransfer[] {
  const transfers = (result as { transfers?: RawAssetTransfer[] })?.transfers ?? [];
  const out: AlchemyTransfer[] = [];
  for (const t of transfers) {
    if (!t.blockNum) continue;
    out.push({
      blockNumber: Number(BigInt(t.blockNum)),
      hash: t.hash ?? "",
      from: (t.from ?? "").toLowerCase(),
      to: (t.to ?? "").toLowerCase(),
      contractAddress: (t.rawContract?.address ?? "").toLowerCase(),
    });
  }
  return out;
}

/**
 * Все ERC20 transfers кошелька (incoming + outgoing) через 2 вызова
 * getAssetTransfers (toAddress + fromAddress — API не фильтрует обе сразу).
 * Возвращает from/to/contract/blockNumber для матча с lpTokenId.
 */
export async function fetchAlchemyWalletTransfers(
  chainCode: string,
  wallet: string,
): Promise<AlchemyTransfer[]> {
  const common = {
    fromBlock: "0x0",
    toBlock: "latest",
    category: ["erc20"],
    order: "asc",
    maxCount: "0x3e8", // 1000
  };
  const [incoming, outgoing] = await Promise.all([
    alchemyRpc(chainCode, "alchemy_getAssetTransfers", [
      { ...common, toAddress: wallet },
    ]),
    alchemyRpc(chainCode, "alchemy_getAssetTransfers", [
      { ...common, fromAddress: wallet },
    ]),
  ]);
  return [...mapTransfers(incoming), ...mapTransfers(outgoing)];
}

/**
 * Резолвит unix-timestamp для набора блоков через eth_getBlockByNumber.
 * Нужно для chains где getAssetTransfers не отдаёт metadata.blockTimestamp
 * (Avalanche). Возвращает Map<blockNumber, unixSeconds>.
 */
export async function fetchBlockTimestamps(
  chainCode: string,
  blockNumbers: readonly number[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const unique = Array.from(new Set(blockNumbers));
  const results = await Promise.all(
    unique.map(async (bn) => {
      const block = (await alchemyRpc(chainCode, "eth_getBlockByNumber", [
        "0x" + bn.toString(16),
        false,
      ])) as { timestamp?: string } | null;
      return { bn, ts: block?.timestamp ? Number(BigInt(block.timestamp)) : null };
    }),
  );
  for (const { bn, ts } of results) {
    if (ts != null) out.set(bn, ts);
  }
  return out;
}

export function isAlchemyChainSupported(chainCode: string): boolean {
  return CHAIN_TO_SUBDOMAIN[chainCode.toLowerCase()] != null;
}
