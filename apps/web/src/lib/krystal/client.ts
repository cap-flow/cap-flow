/**
 * Krystal Cloud HTTP client.
 *
 * Routed через backend upstream-proxy (`/api/v1/upstream/krystal/*`) —
 * server-side держит `KRYSTAL_API_KEY` env, фронт ничего не знает. Auth
 * через `cap_access` cookie от `requireAuth` middleware. См.
 * `apps/api/src/modules/upstream-proxy/upstream-proxy.service.ts` для
 * provider config (path allow-list + KC-APIKey injection).
 *
 * Один call в `v1/positions?wallet={addr}&positionStatus=OPEN&protocols=uniswap`
 * = 10 credits. Возвращает все V3/V4 NFT'ы юзера на всех supported chains.
 *
 * Документация Krystal: https://cloud.krystal.app/docs
 */

import { apiFetch } from "@/lib/api/client";
import type { KrystalPosition, KrystalTransaction } from "./types";

export interface KrystalCreditMeter {
  before: number;
  cost: number;
  left: number;
}

export interface KrystalResult<T> {
  data: T;
  credits?: KrystalCreditMeter;
}

function parseCreditHeaders(h: Headers): KrystalCreditMeter | undefined {
  const before = Number(h.get("KC-Credits-Before"));
  const cost = Number(h.get("KC-Credits-Cost"));
  const left = Number(h.get("KC-Credits-Left"));
  if (!Number.isFinite(before) && !Number.isFinite(left)) return undefined;
  return { before, cost, left };
}

/**
 * Получить все OPEN Uniswap V3 / V4 LP позиции для одного wallet.
 *
 * Note: protocol filter "uniswap" покрывает Uniswap V2/V3/V4. На нашей
 * стороне фильтруем дальше по `protocol.key === "uniswapv3"` в adapter.
 */
export async function fetchKrystalUniswapV3Positions(
  wallet: string,
  options?: { signal?: AbortSignal },
): Promise<KrystalResult<KrystalPosition[]>> {
  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    throw new Error(`Invalid wallet address: ${wallet}`);
  }
  const qs = new URLSearchParams({
    wallet,
    positionStatus: "OPEN",
    protocols: "uniswap",
  });
  const path = `/v1/upstream/krystal/v1/positions?${qs.toString()}`;

  const res = await apiFetch(path, {
    method: "GET",
    ...(options?.signal && { signal: options.signal }),
  });

  if (res.status === 401) throw new Error("Krystal proxy: unauthorized");
  if (res.status === 402) throw new Error("Krystal: out of credits");
  if (res.status === 429) throw new Error("Krystal: rate limited");
  if (!res.ok) throw new Error(`Krystal proxy: HTTP ${res.status}`);

  const data = (await res.json()) as KrystalPosition[];
  const credits = parseCreditHeaders(res.headers);
  return credits ? { data, credits } : { data };
}

/**
 * Получить per-tx историю событий (DEPOSIT / WITHDRAW / COLLECT_FEE) для
 * конкретного V3/V4 NFT.
 *
 * Endpoint: `/v1/positions/{chainId}/{npmAddress}-{tokenId}/transactions`
 * (см. 2026-05-27 VolnyySanya audit: подтверждён на BASE/ETH/ARB byte-в-byte).
 *
 * Возвращает массив events newest-first. Каждый event имеет `type` (string),
 * `txHash`, `blockTime` (unix sec), и `transactions[]` с per-token amounts +
 * **historical USD** (slot0/oracle price at block, не current spot).
 *
 * Используется для построения `OpenPosition.feesClaimedHistory` без
 * необходимости own on-chain Collect event indexer (Variant 1).
 */
export async function fetchKrystalPositionTransactions(args: {
  chainId: number;
  npmAddress: string;
  tokenId: string | bigint;
  options?: { signal?: AbortSignal };
}): Promise<KrystalResult<KrystalTransaction[]>> {
  const npm = args.npmAddress.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(npm)) {
    throw new Error(`Invalid NPM address: ${args.npmAddress}`);
  }
  const tokenIdStr = String(args.tokenId);
  if (!/^\d+$/.test(tokenIdStr)) {
    throw new Error(`Invalid tokenId: ${tokenIdStr}`);
  }
  const path = `/v1/upstream/krystal/v1/positions/${args.chainId}/${npm}-${tokenIdStr}/transactions`;

  const res = await apiFetch(path, {
    method: "GET",
    ...(args.options?.signal && { signal: args.options.signal }),
  });

  if (res.status === 401) throw new Error("Krystal proxy: unauthorized");
  if (res.status === 402) throw new Error("Krystal: out of credits");
  if (res.status === 429) throw new Error("Krystal: rate limited");
  if (res.status === 404) {
    // Position не найдена — возвращаем пустой массив (graceful).
    return { data: [] };
  }
  if (!res.ok) throw new Error(`Krystal proxy: HTTP ${res.status}`);

  const data = (await res.json()) as KrystalTransaction[];
  const credits = parseCreditHeaders(res.headers);
  return credits ? { data, credits } : { data };
}
