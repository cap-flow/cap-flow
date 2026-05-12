/**
 * React hook: для всех Aave V3 lending позиций кошельков подгружает LT/LTV
 * для каждого supply asset'а через AaveProtocolDataProvider.getReserveConfigurationData.
 *
 * Используется в HomePage для ТОЧНОГО расчёта per-asset цены ликвидации
 * в multi-collateral позициях (POS-007: WETH + WBTC). Без точных LT'ов
 * получаем 2-5% drift у активов с разными LT (Aave WETH=83%, WBTC=78%).
 *
 * Возвращает Map "${chain}|${asset_addr}" → AaveReserveConfig.
 */

import { useEffect, useMemo, useState } from "react";

import type { Loaded } from "@/components/data/LoadedWalletsProvider";
import {
  aaveReserveConfigKey,
  fetchAaveReserveConfigs,
  type AaveReserveConfig,
} from "./data_provider";

export type AaveReserveConfigMap = Map<string, AaveReserveConfig>;

interface State {
  data: AaveReserveConfigMap;
  loading: boolean;
}

const EMPTY: AaveReserveConfigMap = new Map();

export function useAaveReserveConfigs(
  loaded: Loaded[],
  alchemyKey: string,
): State {
  // Список (chain, asset) для всех supply токенов в Aave V3 lending позициях.
  const requests = useMemo(() => {
    if (!alchemyKey) return [];
    const items: { chainCode: string; assetAddress: string }[] = [];
    const seen = new Set<string>();
    for (const l of loaded) {
      if (l.wallet.chain !== "evm") continue;
      if (!l.live) continue;
      for (const lp of l.live.positions) {
        // Aave V3 detection — protocolName + lending category.
        const isAaveV3 = /aave\s*v?3/i.test(lp.protocolName);
        if (!isAaveV3) continue;
        if (lp.category !== "lending") continue;
        for (const s of lp.supply) {
          if (!s.tokenId) continue;
          // Снимаем chain prefix у tokenId если есть.
          const addr = s.tokenId.includes(":")
            ? s.tokenId.split(":").pop()!
            : s.tokenId;
          if (!addr.startsWith("0x")) continue;
          // ВАЖНО: asset address должен быть UNDERLYING (WETH/WBTC), а не
          // aToken receipt. У DeBank `s.tokenId` для supply_token_list — это
          // underlying address. Для receipt'ов был бы aToken.
          // Проверка: если symbol начинается с 'a' (aWETH) → пропускаем,
          // это receipt; underlying придёт в borrow или другом item'е.
          if (/^a[A-Z]/.test(s.symbol) || /^variableDebt/.test(s.symbol)) {
            continue;
          }
          const key = `${lp.chain}|${addr.toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          items.push({ chainCode: lp.chain, assetAddress: addr });
        }
      }
    }
    return items;
  }, [loaded, alchemyKey]);

  const [data, setData] = useState<AaveReserveConfigMap>(EMPTY);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (requests.length === 0 || !alchemyKey) {
      setData(EMPTY);
      return;
    }
    let cancelled = false;
    const ctrl = new AbortController();
    setLoading(true);
    void fetchAaveReserveConfigs(requests, alchemyKey, ctrl.signal)
      .then((m) => {
        if (cancelled) return;
        setData(m);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          console.warn("[Aave LT] bulk fetch failed", err);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [requests, alchemyKey]);

  return { data, loading };
}

export { aaveReserveConfigKey };
export type { AaveReserveConfig };
