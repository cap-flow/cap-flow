/**
 * Курс USD/RUB с CBR (Bank of Russia, открытый JSON, CORS-friendly).
 * Кэшируется в localStorage на 6 часов.
 */

import { useEffect, useState } from "react";

const CACHE_KEY = "capflow.fx_usd_rub";
const TTL_MS = 6 * 60 * 60 * 1000; // 6 часов
const FALLBACK_RATE = 90; // приближённая страховка

interface CachedRate {
  rate: number;
  fetchedAt: number;
  source: string;
}

async function fetchUsdRub(): Promise<CachedRate | null> {
  try {
    const r = await fetch("https://www.cbr-xml-daily.ru/daily_json.js");
    if (!r.ok) return null;
    const j = (await r.json()) as { Valute?: { USD?: { Value?: number } } };
    const v = j?.Valute?.USD?.Value;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
    return { rate: v, fetchedAt: Date.now(), source: "cbr-xml-daily" };
  } catch {
    return null;
  }
}

export function useUsdRub(): { rate: number; loading: boolean; source: string } {
  const [state, setState] = useState<CachedRate>(() => {
    if (typeof window === "undefined")
      return { rate: FALLBACK_RATE, fetchedAt: 0, source: "fallback" };
    try {
      const raw = window.localStorage.getItem(CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as CachedRate;
        if (
          parsed &&
          typeof parsed.rate === "number" &&
          Date.now() - parsed.fetchedAt < TTL_MS
        ) {
          return parsed;
        }
      }
    } catch {
      /* ignore */
    }
    return { rate: FALLBACK_RATE, fetchedAt: 0, source: "fallback" };
  });
  const [loading, setLoading] = useState(state.source === "fallback");

  useEffect(() => {
    if (state.source !== "fallback" && Date.now() - state.fetchedAt < TTL_MS)
      return;
    let cancelled = false;
    setLoading(true);
    void fetchUsdRub().then((res) => {
      if (cancelled || !res) {
        setLoading(false);
        return;
      }
      setState(res);
      setLoading(false);
      try {
        window.localStorage.setItem(CACHE_KEY, JSON.stringify(res));
      } catch {
        /* ignore */
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { rate: state.rate, loading, source: state.source };
}
