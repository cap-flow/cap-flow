/**
 * Krystal Cloud HTTP client.
 *
 * REST API: https://cloud-api.krystal.app — auth через `KC-APIKey` header.
 * Документация: https://cloud.krystal.app/docs
 *
 * Один call в `/v1/positions?wallet={addr}&positionStatus=OPEN&protocols=uniswap`
 * = 10 credits. Возвращает все V3/V4 NFT'ы юзера на всех supported chains
 * одним response'ом (Krystal cross-chain aggregates).
 */

import type { KrystalPosition } from "./types";

const BASE_URL = "https://cloud-api.krystal.app";

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
 * стороне фильтруем дальше по `protocol.key === "uniswapv3"` если нужно
 * (например, в adapter'е).
 */
export async function fetchKrystalUniswapV3Positions(
  wallet: string,
  apiKey: string,
  options?: { signal?: AbortSignal },
): Promise<KrystalResult<KrystalPosition[]>> {
  if (!apiKey) throw new Error("Krystal API key required");
  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    throw new Error(`Invalid wallet address: ${wallet}`);
  }
  const url = new URL("/v1/positions", BASE_URL);
  url.searchParams.set("wallet", wallet);
  url.searchParams.set("positionStatus", "OPEN");
  url.searchParams.set("protocols", "uniswap");

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "KC-APIKey": apiKey,
      Accept: "application/json",
    },
    ...(options?.signal && { signal: options.signal }),
  });

  if (res.status === 401) throw new Error("Krystal: unauthorized (invalid API key)");
  if (res.status === 402) throw new Error("Krystal: out of credits");
  if (res.status === 429) throw new Error("Krystal: rate limited");
  if (!res.ok) throw new Error(`Krystal: HTTP ${res.status}`);

  const data = (await res.json()) as KrystalPosition[];
  const credits = parseCreditHeaders(res.headers);
  return credits ? { data, credits } : { data };
}
