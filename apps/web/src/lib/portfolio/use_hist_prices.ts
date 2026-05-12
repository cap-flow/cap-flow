/**
 * Shared hook для получения исторических цен из DefiLlama по ВСЕМ
 * выходам активов в кошельке за всё время. Нужен для универсального
 * asset-centric учёта: каждое out-движение `lp_add` / `lend_supply` /
 * `stake` / `swap` должно получать USD-стоимость по hist-price на момент
 * op'а, а не по current spot. Без этого LotTracker WAC искажается.
 *
 * Используется на ВСЕХ страницах, где строится `buildOpenPositions`:
 *   - HomePage (Сводка по капиталу + Cap Wallet)
 *   - OpenPositionsPage (Лист открытых позиций)
 *   - PortfolioPage / WalletDetailPage / Dashboard metrics
 *
 * Кеш на уровне `fetchHistoricalPrices` (localStorage) — повторных
 * запросов нет, после первого пользовательского визита всё работает оффлайн.
 */

import { useEffect, useMemo, useState } from "react";

import { defillamaCoinKey, fetchHistoricalPrices } from "../defillama";
import type { Loaded } from "@/components/data/LoadedWalletsProvider";

export function useWalletHistPrices(loadedList: Loaded[]): {
  histPrices: Map<string, number>;
  loading: boolean;
} {
  // Какие пары `(coin, timestamp)` нужны: проходим по ВСЕМ ops, для каждого
  // non-stable token movement (OUT для cost basis swap'ов, IN для transfer_in
  // покупок где DeBank m.usd ≠ historical) строим coinKey + берём op.time.
  // Это покрывает: swap, lp_add, lend_supply, stake, transfer_out, repay,
  // withdraw_fiat (out) + transfer_in (in) — для аудита истории покупок.
  const histRequests = useMemo(() => {
    const items: { coin: string; timestamp: number }[] = [];
    const seen = new Set<string>();
    for (const l of loadedList) {
      for (const op of l.ops) {
        if (op.status === "failed") continue;
        for (const m of op.movement) {
          if (m.amount <= 0) continue;
          // Газ ETH (микро < 0.01) — не нужен для cost basis.
          if (
            (m.symbol === "ETH" || m.symbol === "WETH") &&
            m.amount < 0.01
          )
            continue;
          // Стейблы — цена ≈ $1 везде, не запрашиваем (экономим квоту).
          if (m.isStable) continue;
          // Receipt-tokens (aTokens, GM, GLV) — DefiLlama не имеет, не запрашиваем.
          if (m.isProtocolToken) continue;
          // OUT — для cost basis, IN — для покупок (transfer_in popup).
          if (m.direction !== "out" && m.direction !== "in") continue;
          const coin = defillamaCoinKey(op.chain, m.tokenId, m.symbol);
          if (!coin) continue;
          // Группируем по часу — для того же coin в одном часе один запрос.
          const key = `${coin}|${Math.floor(op.time / 3600)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          items.push({ coin, timestamp: op.time });
        }
      }
    }
    return items;
  }, [loadedList]);

  const [histPrices, setHistPrices] = useState<Map<string, number>>(
    new Map(),
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (histRequests.length === 0) {
      setHistPrices(new Map());
      return;
    }
    let cancelled = false;
    const ctrl = new AbortController();
    setLoading(true);
    void fetchHistoricalPrices(histRequests, ctrl.signal)
      .then((m) => {
        if (!cancelled) setHistPrices(m);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          console.warn("useWalletHistPrices: fetch failed", err);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [histRequests]);

  return { histPrices, loading };
}
