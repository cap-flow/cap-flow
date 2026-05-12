/**
 * React hook для подгрузки точных USD-цен V3 mint'ов через `pool.slot0()` на
 * mint-блоке. Заменяет (приоритетно) DefiLlama hourly-bucket цены для V3 LP.
 *
 * Применение: в страницах со списком позиций. Возвращает Map, которая
 * передаётся в `buildOpenPositions({ v3MintPoolPrices })`.
 */

import { useEffect, useMemo, useState } from "react";

import type { Loaded } from "@/components/data/LoadedWalletsProvider";
import { isV3LpProtocol } from "../portfolio/open_positions";
import {
  fetchPoolMintPrices,
  type FetchPoolMintPriceArgs,
} from "./historical_pool_price";

export interface V3MintPoolPrice {
  /** Цена token1 за 1 token0 (после поправки на decimals). */
  price1Per0: number;
  /** Адреса token0/token1 — для маппинга на amount0/amount1 в op'е. */
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
  /**
   * USD-якорь для volatile/volatile pool'ов: точная цена ETH (или другого
   * major-токена) на блоке mint'а, прочитанная из WETH/USDC anchor pool.
   * Если задан — buildV3Details использует его вместо DefiLlama hourly
   * bucket, что устраняет ~0.2-0.5% drift и даёт байт-в-байт совпадение
   * с Revert Finance.
   */
  anchorTokenAddress?: string;
  anchorTokenUsd?: number;
  /**
   * Точные atomic amounts из Pool.Mint event (uint256 → строка в JSON-safe
   * формате). Деноминированы в native units; деление на 10^decimals даёт
   * human-units, точные до последнего wei. Заменяют DeBank's `m.amount`
   * (округлён до ~8 знаков).
   */
  exactAmount0?: string;
  exactAmount1?: string;
}

/** Map<`${chain}|${txHash}`, V3MintPoolPrice>. */
export type V3MintPoolPriceMap = Map<string, V3MintPoolPrice>;

const EMPTY: V3MintPoolPriceMap = new Map();

interface State {
  data: V3MintPoolPriceMap;
  loading: boolean;
}

export function useV3HistoricalPoolPrices(
  loaded: Loaded[],
  alchemyKey: string,
): State {
  // Какие (chain, pool, txHash) нужны: V3 lp_add ops, у которых есть live
  // позиция в этом протоколе+chain (= ещё не закрыт NFT). Это снимает
  // лишние RPC-запросы на старые закрытые позиции.
  const requests = useMemo<FetchPoolMintPriceArgs[]>(() => {
    if (!alchemyKey) return [];
    const items: FetchPoolMintPriceArgs[] = [];
    const seen = new Set<string>();

    // Helper: канонический ключ пары для маппинга live → mint.
    // normalizeSymbol важен — иначе ETH/WETH дают разные ключи.
    function pairKey(symbols: string[]): string {
      return [...symbols]
        .map((s) => {
          const u = s.toUpperCase();
          if (u === "WETH") return "ETH";
          if (u === "WBTC") return "BTC";
          if (u === "WMATIC") return "MATIC";
          if (u === "WBNB") return "BNB";
          return u;
        })
        .sort()
        .join("+");
    }

    for (const l of loaded) {
      if (l.wallet.chain !== "evm") continue;
      if (!l.live) continue;
      // Карта (protocol|chain|pair) → pool address. КРИТИЧНО: ключ
      // включает пару символов, иначе для (uniswap-v3-arb) с WETH/USDC
      // и WETH/ARB позициями карта схлопнется в ОДИН pool, и для всех
      // mint'ов будет читаться slot0 одного и того же пула (баг
      // POS-001 на Alex 2026-05-08: WETH/USDC mint читал slot0 у
      // WETH/ARB пула → t1 USD считалось как ARB-USD).
      const v3Pools = new Map<string, string>();
      for (const lp of l.live.positions) {
        if (!isV3LpProtocol(lp.protocolName)) continue;
        if (!lp.lpTokenId) continue;
        const pair = pairKey(lp.supply.map((s) => s.symbol));
        v3Pools.set(`${lp.protocolId}|${lp.chain}|${pair}`, lp.lpTokenId);
      }
      if (v3Pools.size === 0) continue;
      // Собираем V3 lp_add ops в этих протоколах.
      for (const op of l.ops) {
        if (op.status === "failed") continue;
        if (op.type !== "lp_add") continue;
        if (!op.protocol) continue;
        if (!isV3LpProtocol(op.protocol.name)) continue;
        // Определяем pair op'а по его OUT движениям (без gas-микро ETH).
        const outSyms = op.movement
          .filter(
            (m) =>
              m.direction === "out" &&
              m.amount > 0 &&
              !m.isProtocolToken &&
              !(
                (m.symbol === "ETH" || m.symbol === "WETH") &&
                m.amount < 0.01 &&
                (m.usd ?? 0) < 100
              ),
          )
          .map((m) => m.symbol);
        if (outSyms.length === 0) continue;
        const opPair = pairKey(outSyms);
        const pcKey = `${op.protocol.id}|${op.chain}|${opPair}`;
        const pool = v3Pools.get(pcKey);
        if (!pool) continue;
        const key = `${op.chain}|${op.hash.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
          chainCode: op.chain,
          poolAddress: pool,
          txHash: op.hash,
          alchemyApiKey: alchemyKey,
        });
      }
    }
    return items;
  }, [loaded, alchemyKey]);

  const [data, setData] = useState<V3MintPoolPriceMap>(EMPTY);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (requests.length === 0) {
      setData(EMPTY);
      return;
    }
    let cancelled = false;
    const ctrl = new AbortController();
    setLoading(true);
    void fetchPoolMintPrices(requests, ctrl.signal)
      .then((m) => {
        if (cancelled) return;
        const result: V3MintPoolPriceMap = new Map();
        for (const [k, v] of m) {
          result.set(k, {
            price1Per0: v.price1Per0,
            token0: v.token0,
            token1: v.token1,
            decimals0: v.decimals0,
            decimals1: v.decimals1,
            anchorTokenAddress: v.anchorTokenAddress,
            anchorTokenUsd: v.anchorTokenUsd,
            exactAmount0: v.exactAmount0,
            exactAmount1: v.exactAmount1,
          });
        }
        setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          console.warn("useV3HistoricalPoolPrices: fetch failed", err);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [requests]);

  return { data, loading };
}
