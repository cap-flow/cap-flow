/**
 * React hook: загружает V3 LP позиции из Krystal Cloud для всех EVM-кошельков
 * портфеля и строит lookup-карту по `tokenId`.
 *
 * PR-K1 (cross-validation only). PR-K3 (future): станет primary source
 * для V3 current state когда `capflow.feature.krystalV3Primary` ON.
 *
 * Cost: 10 credits per wallet per fetch. Дедупим wallets и кешируем
 * в module scope (refresh при изменении wallet list или ручном refresh).
 */

import { useEffect, useMemo, useState } from "react";

import type { Loaded } from "@/components/data/LoadedWalletsProvider";
import { buildKrystalSummaryMap, type KrystalV3Summary } from "./adapter";
import { readKrystalCache, writeKrystalCache } from "./cache";
import { fetchKrystalUniswapV3Positions } from "./client";
import type { KrystalPosition } from "./types";

export interface KrystalV3State {
  /** key: tokenId (string). Merged across all wallets. */
  data: Map<string, KrystalV3Summary>;
  loading: boolean;
  error: string | null;
  /** Remaining credits после последнего fetch — UI surfacing. */
  creditsLeft: number | null;
}

const EMPTY: KrystalV3State = {
  data: new Map(),
  loading: false,
  error: null,
  creditsLeft: null,
};

/**
 * Backend upstream-proxy инжектит server-side `KRYSTAL_API_KEY`,
 * фронту никаких ключей не нужно. Hook gating: `enabled` flag + wallet list.
 */
export function useKrystalV3Positions(
  loaded: Loaded[],
  enabled: boolean,
): KrystalV3State {
  const wallets = useMemo<string[]>(() => {
    if (!enabled) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const l of loaded) {
      if (l.wallet.chain !== "evm") continue;
      const a = l.wallet.address.toLowerCase();
      if (seen.has(a)) continue;
      seen.add(a);
      out.push(l.wallet.address);
    }
    return out;
  }, [loaded, enabled]);

  const [state, setState] = useState<KrystalV3State>(EMPTY);

  useEffect(() => {
    if (!enabled || wallets.length === 0) {
      setState(EMPTY);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));

    (async () => {
      const all: KrystalPosition[] = [];
      const errors: string[] = [];
      let creditsLeft: number | null = null;
      let cacheHits = 0;
      let fetched = 0;
      for (const w of wallets) {
        if (cancelled) return;
        // PR-K4: try 24h localStorage cache first.
        const cached = readKrystalCache(w);
        if (cached !== null) {
          all.push(...cached);
          cacheHits++;
          continue;
        }
        try {
          const { data, credits } = await fetchKrystalUniswapV3Positions(w, {
            signal: controller.signal,
          });
          all.push(...data);
          writeKrystalCache(w, data);
          fetched++;
          if (credits?.left != null) creditsLeft = credits.left;
        } catch (e) {
          if ((e as Error).name === "AbortError") return;
          errors.push(`${w.slice(0, 6)}…: ${(e as Error).message}`);
        }
      }
      if (cancelled) return;
      setState({
        data: buildKrystalSummaryMap(all),
        loading: false,
        error: errors.length > 0 ? errors.join("; ") : null,
        creditsLeft,
      });
      if (typeof window !== "undefined") {
        console.log(
          `[Krystal V3] ${all.length} positions ` +
            `(${cacheHits} cache hits, ${fetched} fresh fetches) ` +
            `from ${wallets.length} wallets` +
            (creditsLeft != null ? ` (credits left: ${creditsLeft})` : "") +
            (errors.length > 0 ? ` — errors: ${errors.join("; ")}` : ""),
        );
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [wallets, enabled]);

  return state;
}
