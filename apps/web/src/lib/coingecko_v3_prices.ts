/**
 * React hook: для всех V3 mint'ов (lp_add ops у которых есть live позиция)
 * подгружает CoinGecko USD цены **обоих** токенов на timestamp mint'а.
 *
 * Это primary источник цен для V3 startUsd (совпадает с методологией Revert
 * Finance — multi-source aggregator price на timestamp tx). Slot0 anchor
 * pool остаётся fallback'ом если CoinGecko вернул null.
 *
 * Возвращает Map<`${chain}|${txHash}`, V3MintCoinGeckoPrices>.
 */

import { useEffect, useMemo, useState } from "react";

import type { Loaded } from "@/components/data/LoadedWalletsProvider";
import { fetchCoinGeckoPricesBulk, coinGeckoBulkKey } from "./coingecko";
import { isV3LpProtocol } from "./portfolio/open_positions";

export interface V3MintCoinGeckoPrices {
  /** Map: lower-case token contract address → USD price на timestamp mint'а. */
  byAddress: Map<string, number>;
  /** Timestamp на который смотрели (для diagnostic). */
  timestamp: number;
}

export type V3MintCoinGeckoPriceMap = Map<string, V3MintCoinGeckoPrices>;

const EMPTY: V3MintCoinGeckoPriceMap = new Map();

interface State {
  data: V3MintCoinGeckoPriceMap;
  loading: boolean;
}

export function useV3CoinGeckoPrices(loaded: Loaded[]): State {
  // Собираем (chain, address, timestamp) для каждого movement в каждом
  // V3 mint'е, у которого есть match в live positions.
  const requests = useMemo(() => {
    const items: { chainCode: string; address: string; timestamp: number }[] = [];
    const seen = new Set<string>();
    // Регистрируем txHash → timestamp для post-processing.
    const txByKey = new Map<string, { chain: string; txHash: string; ts: number; addrs: Set<string> }>();

    for (const l of loaded) {
      if (l.wallet.chain !== "evm") continue;
      if (!l.live) continue;
      // Проверяем есть ли V3 lp в live state — иначе нет смысла фетчить
      // historical mints (они закрыты).
      const hasV3 = l.live.positions.some((p) => isV3LpProtocol(p.protocolName));
      if (!hasV3) continue;
      for (const op of l.ops) {
        if (op.status === "failed") continue;
        if (op.type !== "lp_add") continue;
        if (!op.protocol) continue;
        if (!isV3LpProtocol(op.protocol.name)) continue;
        // Каждое out-движение — отдельный токен который надо оценить.
        for (const m of op.movement) {
          if (m.direction !== "out" || m.amount <= 0) continue;
          const stripPrefix = (id: string): string =>
            id.includes(":") ? id.split(":").pop()! : id;
          const addr = stripPrefix(m.tokenId).toLowerCase();
          if (!addr) continue;
          const k = `${op.chain}|${addr}|${op.time}`;
          if (seen.has(k)) continue;
          seen.add(k);
          items.push({ chainCode: op.chain, address: addr, timestamp: op.time });
          // Запоминаем сопоставление tx → addresses для построения byAddress map.
          const txKey = `${op.chain}|${op.hash.toLowerCase()}`;
          let entry = txByKey.get(txKey);
          if (!entry) {
            entry = {
              chain: op.chain,
              txHash: op.hash.toLowerCase(),
              ts: op.time,
              addrs: new Set(),
            };
            txByKey.set(txKey, entry);
          }
          entry.addrs.add(addr);
        }
      }
    }
    return { items, txByKey };
  }, [loaded]);

  const [data, setData] = useState<V3MintCoinGeckoPriceMap>(EMPTY);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (requests.items.length === 0) {
      setData(EMPTY);
      return;
    }
    let cancelled = false;
    const ctrl = new AbortController();
    setLoading(true);
    void fetchCoinGeckoPricesBulk(requests.items, ctrl.signal)
      .then((priceMap) => {
        if (cancelled) return;
        const result: V3MintCoinGeckoPriceMap = new Map();
        for (const [txKey, entry] of requests.txByKey) {
          const byAddress = new Map<string, number>();
          for (const addr of entry.addrs) {
            const k = coinGeckoBulkKey(entry.chain, addr, entry.ts);
            const price = priceMap.get(k);
            if (price != null) byAddress.set(addr, price);
          }
          if (byAddress.size > 0) {
            result.set(txKey, { byAddress, timestamp: entry.ts });
          }
        }
        setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          console.warn("[V3 coingecko] bulk fetch failed", err);
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
