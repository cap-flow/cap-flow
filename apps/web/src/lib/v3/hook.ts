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

/** На пару (walletId, chain, deploymentId, sorted-symbols) — массив позиций. */
export type V3PositionMap = Map<string, V3Position[]>;

/**
 * WETH↔ETH канонизация для ключа. DeBank live-позиции часто отдают
 * underlying как нативный `ETH`, а on-chain token0.symbol = `WETH`
 * (напр. Velodrome WETH/WBTC → live "ETH+WBTC"). Без канона ключи не
 * совпадают и override не паркует cost basis. То же делает `normalize`
 * в v3_cost_basis_override.ts для price-lookup.
 */
function canonSymbol(s: string): string {
  return s.toUpperCase() === "WETH" ? "ETH" : s.toUpperCase();
}

/** Канонический ключ для матча V3-позиций с UI-строкой OpenPosition. */
export function v3PositionKey(args: {
  walletId: string;
  chain: string;
  deploymentId: string;
  symbols: string[];
}): string {
  const sorted = args.symbols.map(canonSymbol).sort();
  return `${args.walletId}|${args.chain}|${args.deploymentId}|${sorted.join("|")}`;
}

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
