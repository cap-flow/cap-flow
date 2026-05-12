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
  type V3Position,
} from "./positions";

/** На пару (walletId, chain, deploymentId, sorted-symbols) — массив позиций. */
export type V3PositionMap = Map<string, V3Position[]>;

/** Канонический ключ для матча V3-позиций с UI-строкой OpenPosition. */
export function v3PositionKey(args: {
  walletId: string;
  chain: string;
  deploymentId: string;
  symbols: string[];
}): string {
  const sorted = args.symbols.map((s) => s.toUpperCase()).sort();
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
            const positions = await fetchV3PositionsForDeployment(
              t.deployment,
              t.address as `0x${string}`,
              alchemyKey,
            );
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
