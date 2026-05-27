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
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (const w of wallets) {
        if (cancelled) return;
        // PR-K4: try 24h localStorage cache first.
        const cached = readKrystalCache(w);
        if (cached !== null) {
          all.push(...cached);
          cacheHits++;
          continue;
        }
        // PR-K26 (2026-05-27 urgent fix to PR-K25): SEQUENTIAL fetch OPEN
        // then CLOSED (was Promise.all → reject whole batch on 429 → cache
        // write skipped → ALL positions become UNMATCHED across all wallets).
        // Throttle 400ms между OPEN/CLOSED калls для одного wallet — снижает
        // вероятность Krystal rate-limit. Используем Promise.allSettled-like
        // independent error handling: если CLOSED fails (e.g. 429), всё равно
        // сохраняем OPEN.
        let openPositions: KrystalPosition[] = [];
        let closedPositions: KrystalPosition[] = [];
        let walletHadAnyData = false;

        try {
          const openResult = await fetchKrystalUniswapV3Positions(w, "OPEN", {
            signal: controller.signal,
          });
          openPositions = openResult.data;
          walletHadAnyData = true;
          if (openResult.credits?.left != null) creditsLeft = openResult.credits.left;
        } catch (e) {
          if ((e as Error).name === "AbortError") return;
          errors.push(`${w.slice(0, 6)}… OPEN: ${(e as Error).message}`);
        }
        await sleep(400);

        try {
          const closedResult = await fetchKrystalUniswapV3Positions(w, "CLOSED", {
            signal: controller.signal,
          });
          closedPositions = closedResult.data;
          walletHadAnyData = true;
          if (closedResult.credits?.left != null) creditsLeft = closedResult.credits.left;
        } catch (e) {
          if ((e as Error).name === "AbortError") return;
          // Soft fail — OPEN may have succeeded, ещё сохраним cache.
          errors.push(`${w.slice(0, 6)}… CLOSED: ${(e as Error).message}`);
        }

        if (walletHadAnyData) {
          // Merge: deduplicate by (chain.id, tokenAddress, tokenId).
          const seen = new Set<string>();
          const merged: KrystalPosition[] = [];
          for (const pos of [...openPositions, ...closedPositions]) {
            const key = `${pos.chain?.id}-${pos.tokenAddress?.toLowerCase()}-${pos.tokenId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(pos);
          }
          all.push(...merged);
          writeKrystalCache(w, merged);
          fetched++;
        }
        // Throttle между wallets — снижает burst load на Krystal.
        await sleep(300);
      }
      if (cancelled) return;
      setState({
        data: buildKrystalSummaryMap(all),
        loading: false,
        error: errors.length > 0 ? errors.join("; ") : null,
        creditsLeft,
      });
      if (typeof window !== "undefined") {
        const openCount = all.filter(p => p.status !== "CLOSED").length;
        const closedCount = all.filter(p => p.status === "CLOSED").length;
        console.log(
          `[Krystal V3] ${all.length} positions ` +
            `(${openCount} OPEN, ${closedCount} CLOSED; ` +
            `${cacheHits} cache hits, ${fetched} fresh fetches) ` +
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
