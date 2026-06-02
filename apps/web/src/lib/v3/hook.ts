/**
 * React-хук: загружает V3 позиции для всех EVM-кошельков, у которых есть
 * хоть одна V3-style LP (Uniswap / PancakeSwap / SushiSwap V3) в live-state.
 *
 * Возвращает Map по ключу `${walletId}|${chain}|${deploymentId}|${pairKey}`.
 * Один и тот же кошелёк может иметь несколько позиций в одной паре одного
 * протокола (разные fee tier / диапазоны), поэтому значение — массив.
 *
 * Кэшируется в памяти провайдера; перезапрос — на изменение списка
 * кошельков или ключа Alchemy.
 */

import { useEffect, useMemo, useState } from "react";

import type { Loaded } from "@/components/data/LoadedWalletsProvider";
import { findV3Deployments, type V3Deployment } from "./chains";
import {
  fetchV3PositionsForDeployment,
  fetchV3StakedPositions,
  type V3Position,
} from "./positions";

/**
 * Gauge-based DEX'и (Velodrome/Aerodrome CL): позиция стейкается в CLGauge,
 * NFT уходит из кошелька → нужен отдельный staked-discovery. Для остальных
 * (Uniswap и т.п.) NFT остаётся у кошелька, лишний вызов не делаем.
 */
function isGaugeBasedDeployment(dep: V3Deployment): boolean {
  return /velodrome|aerodrome/i.test(dep.id) || /velodrome|aerodrome/i.test(dep.label);
}

// V3PositionMap + v3PositionKey (and the WETH↔ETH canon) moved to
// @cap-flow/ucb/v3_types (B3-full layer 1) so the pure override + the fetch share
// one key builder; re-exported for existing import sites.
import { v3PositionKey } from "@cap-flow/ucb/v3_types";
export { v3PositionKey };
export type { V3PositionMap } from "@cap-flow/ucb/v3_types";
import type { V3PositionMap } from "@cap-flow/ucb/v3_types";

interface State {
  data: V3PositionMap;
  loading: boolean;
  error: string | null;
}

const EMPTY: V3PositionMap = new Map();

interface Target {
  walletId: string;
  address: string;
  deployment: V3Deployment;
}

export function useV3Positions(loaded: Loaded[], alchemyKey: string): State {
  const [data, setData] = useState<V3PositionMap>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Список (walletId, address, deployment) для всех совпадений по чейну + имени.
  const targets = useMemo<Target[]>(() => {
    const out: Target[] = [];
    const seen = new Set<string>();
    for (const l of loaded) {
      if (l.wallet.chain !== "evm") continue;
      if (!l.live) continue;
      for (const p of l.live.positions) {
        const deps = findV3Deployments(p.chain, p.protocolName);
        for (const dep of deps) {
          const key = `${l.wallet.id}|${dep.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            walletId: l.wallet.id,
            address: l.wallet.address,
            deployment: dep,
          });
        }
      }
    }
    return out;
  }, [loaded]);

  useEffect(() => {
    if (!alchemyKey || targets.length === 0) {
      setData(EMPTY);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      const next: V3PositionMap = new Map();
      const errors: string[] = [];
      await Promise.all(
        targets.map(async (t) => {
          try {
            const [owned, staked] = await Promise.all([
              fetchV3PositionsForDeployment(
                t.deployment,
                t.address as `0x${string}`,
                alchemyKey,
              ),
              isGaugeBasedDeployment(t.deployment)
                ? // Таймаут-guard: staked-discovery (getAssetTransfers + ownerOf
                  // multicall) НЕ должен блокировать общий v3-discovery, иначе
                  // медленный/зависший Velodrome-fetch ломает V3-override у ВСЕХ
                  // позиций (outer Promise.all не резолвится → v3.data пуст).
                  Promise.race([
                    fetchV3StakedPositions(
                      t.deployment,
                      t.address as `0x${string}`,
                      alchemyKey,
                    ),
                    new Promise<V3Position[]>((resolve) =>
                      setTimeout(() => resolve([]), 20_000),
                    ),
                  ]).catch((e) => {
                    errors.push(`${t.deployment.id} staked: ${(e as Error).message}`);
                    return [] as V3Position[];
                  })
                : Promise.resolve([] as V3Position[]),
            ]);
            const positions = [...owned, ...staked];
            for (const pos of positions) {
              const k = v3PositionKey({
                walletId: t.walletId,
                chain: t.deployment.chainCode,
                deploymentId: t.deployment.id,
                symbols: [pos.token0.symbol, pos.token1.symbol],
              });
              const arr = next.get(k) ?? [];
              arr.push(pos);
              next.set(k, arr);
            }
          } catch (e) {
            errors.push(`${t.deployment.id}: ${(e as Error).message}`);
          }
        }),
      );
      if (cancelled) return;
      setData(next);
      setLoading(false);
      if (errors.length > 0) setError(errors.join("; "));
    })();

    return () => {
      cancelled = true;
    };
  }, [alchemyKey, targets]);

  return { data, loading, error };
}
