/**
 * Tests for chunkedFetch / chunkedFetchMyTrades.
 *
 * Без них POS-007 WBTC не имеет cost basis: spot покупка WBTC была
 * >7 мес назад, а Bybit/BingX отдают только последние 7 дней.
 * UCB B1.5 закрывает этот data-gap слоя 1.
 */
import { describe, expect, it, vi } from "vitest";

import {
  chunkedFetch,
  chunkedFetchMyTrades,
  chunkedFetchTransfers,
  chunkedFetchTransfersPerAsset,
  HISTORICAL_DAYS_DEFAULT,
  TRADE_MAX_LOOKBACK_DAYS,
  TRADE_WINDOW_DAYS,
  TRANSFER_MAX_LOOKBACK_DAYS,
  TRANSFER_REQUIRES_COIN_FILTER,
  TRANSFER_WINDOW_DAYS,
} from "./cex.history.js";

const DAY = 86_400_000;
const NOW = 1_750_000_000_000; // fixed for deterministic since-defaults

describe("chunkedFetch — constants", () => {
  it("HISTORICAL_DAYS_DEFAULT = 1095 (3 years per user spec)", () => {
    expect(HISTORICAL_DAYS_DEFAULT).toBe(1095);
  });

  it("Bybit / BingX trade window = 7 days (their API limit)", () => {
    expect(TRADE_WINDOW_DAYS["bybit"]).toBe(7);
    expect(TRADE_WINDOW_DAYS["bingx"]).toBe(7);
  });

  it("Bitget trade window null (handles via tax endpoint chunks elsewhere)", () => {
    expect(TRADE_WINDOW_DAYS["bitget"]).toBeNull();
  });

  it("OKX trade window 90 days (their 3-month max)", () => {
    expect(TRADE_WINDOW_DAYS["okx"]).toBe(90);
  });

  it("MEXC trade window 30 days", () => {
    expect(TRADE_WINDOW_DAYS["mexc"]).toBe(30);
  });

  it("Bybit transfer window 30 days (deposits/withdrawals API limit)", () => {
    expect(TRANSFER_WINDOW_DAYS["bybit"]).toBe(30);
  });
});

describe("chunkedFetch — basic loop", () => {
  it("один window если until - since <= windowDays × day", async () => {
    const fn = vi.fn().mockResolvedValue([]);
    const since = NOW - 5 * DAY;
    const until = NOW;
    const r = await chunkedFetch(fn, { since, until, windowDays: 7 });
    expect(r.windows).toBe(1);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith(undefined, since, undefined, { until });
  });

  it("делит интервал на N окон (since=now-30d, window=7d → 5 окон)", async () => {
    const fn = vi.fn().mockResolvedValue([]);
    const r = await chunkedFetch(fn, {
      since: NOW - 30 * DAY,
      until: NOW,
      windowDays: 7,
    });
    // 30 / 7 = 4.28 → 5 окон (последнее truncated до until)
    expect(r.windows).toBe(5);
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it("aggregator: суммирует items из всех окон", async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce([{ id: "a" }, { id: "b" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "c" }]);
    const r = await chunkedFetch<{ id: string }>(fn, {
      since: NOW - 20 * DAY,
      until: NOW,
      windowDays: 7,
    });
    expect(r.items).toHaveLength(3);
    expect(r.items.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("error в одном окне НЕ прерывает loop", async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce([{ id: "ok-1" }])
      .mockRejectedValueOnce(new Error("Rate limit"))
      .mockResolvedValueOnce([{ id: "ok-2" }]);
    const r = await chunkedFetch(fn, {
      since: NOW - 20 * DAY,
      until: NOW,
      windowDays: 7,
    });
    expect(r.items).toHaveLength(2); // ok-1 + ok-2 (middle window errored)
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.message).toMatch(/Rate limit/);
  });

  it("HISTORICAL_DAYS_DEFAULT (3 года) при отсутствии since", async () => {
    // Используем Date.now() для until иначе since (`now - 3y`) может
    // оказаться > фиктивного NOW и loop вернёт 0 окон.
    const fn = vi.fn().mockResolvedValue([]);
    const until = Date.now();
    const r = await chunkedFetch(fn, {
      until,
      windowDays: 7,
    });
    // 1095 days / 7 = 156.4 → 157 окон. Hard cap maxIterations default 200.
    expect(r.windows).toBeGreaterThan(150);
    expect(r.windows).toBeLessThanOrEqual(200);
  });

  it("hard cap через maxIterations предотвращает infinity loop", async () => {
    const fn = vi.fn().mockResolvedValue([]);
    const r = await chunkedFetch(fn, {
      since: NOW - 1095 * DAY,
      until: NOW,
      windowDays: 1,
      maxIterations: 50,
    });
    expect(r.windows).toBe(50);
  });

  it("since >= until → empty result, без вызовов", async () => {
    const fn = vi.fn();
    const r = await chunkedFetch(fn, {
      since: NOW,
      until: NOW - DAY,
      windowDays: 7,
    });
    expect(r.items).toEqual([]);
    expect(r.windows).toBe(0);
    expect(fn).not.toHaveBeenCalled();
  });

  it("windowDays = 0 → throws (catch bug)", async () => {
    const fn = vi.fn();
    await expect(
      chunkedFetch(fn, {
        since: NOW - DAY,
        until: NOW,
        windowDays: 0,
      }),
    ).rejects.toThrow(/positive/);
  });

  it("передаёт symbol в fn", async () => {
    const fn = vi.fn().mockResolvedValue([]);
    await chunkedFetch(fn, {
      since: NOW - DAY,
      until: NOW,
      windowDays: 7,
      symbol: "BTC/USDT",
    });
    expect(fn).toHaveBeenCalledWith(
      "BTC/USDT",
      NOW - DAY,
      undefined,
      { until: NOW },
    );
  });

  it("передаёт extraParams (например limit)", async () => {
    const fn = vi.fn().mockResolvedValue([]);
    await chunkedFetch(fn, {
      since: NOW - DAY,
      until: NOW,
      windowDays: 7,
      extraParams: { limit: 100 },
    });
    expect(fn).toHaveBeenCalledWith(
      undefined,
      NOW - DAY,
      undefined,
      { limit: 100, until: NOW },
    );
  });
});

describe("chunkedFetchMyTrades — wrapper around chunkedFetch", () => {
  it("Bybit (7d window) → loop'ит когда лookback > 7 дней", async () => {
    const fetchMyTrades = vi.fn().mockResolvedValue([]);
    const client = { fetchMyTrades } as unknown as Parameters<
      typeof chunkedFetchMyTrades
    >[0];
    const r = await chunkedFetchMyTrades(client, "bybit", {
      since: NOW - 30 * DAY,
      until: NOW,
    });
    // 30 / 7 = 4.28 → 5 окон
    expect(r.windows).toBe(5);
    expect(fetchMyTrades).toHaveBeenCalledTimes(5);
  });

  it("Bitget (window=null) → single call без chunk'инга", async () => {
    const fetchMyTrades = vi.fn().mockResolvedValue([{ id: "single-result" }]);
    const client = { fetchMyTrades } as unknown as Parameters<
      typeof chunkedFetchMyTrades
    >[0];
    const r = await chunkedFetchMyTrades(client, "bitget", {
      since: NOW - 365 * DAY,
      until: NOW,
    });
    expect(r.windows).toBe(1);
    expect(fetchMyTrades).toHaveBeenCalledOnce();
  });

  it("Bitget error → still returns ChunkedFetchResult с errors", async () => {
    const fetchMyTrades = vi.fn().mockRejectedValue(new Error("400 bad"));
    const client = { fetchMyTrades } as unknown as Parameters<
      typeof chunkedFetchMyTrades
    >[0];
    const r = await chunkedFetchMyTrades(client, "bitget", {
      since: NOW - 30 * DAY,
      until: NOW,
    });
    expect(r.items).toEqual([]);
    expect(r.errors).toHaveLength(1);
  });

  it("OKX 90-day window: 365 days lookback → 5 окон", async () => {
    const fetchMyTrades = vi.fn().mockResolvedValue([]);
    const client = { fetchMyTrades } as unknown as Parameters<
      typeof chunkedFetchMyTrades
    >[0];
    const r = await chunkedFetchMyTrades(client, "okx", {
      since: NOW - 365 * DAY,
      until: NOW,
    });
    expect(r.windows).toBe(Math.ceil(365 / 90));
  });
});

describe("chunkedFetchMyTrades — per-exchange max lookback cap", () => {
  it("TRADE_MAX_LOOKBACK_DAYS — Bybit 720 (2y minus 10d safety margin)", () => {
    expect(TRADE_MAX_LOOKBACK_DAYS["bybit"]).toBe(720);
  });

  it("TRADE_MAX_LOOKBACK_DAYS — BingX 180 (6 months default)", () => {
    expect(TRADE_MAX_LOOKBACK_DAYS["bingx"]).toBe(180);
  });

  it("Bybit cap'ит since на 720 дней назад даже если задано 3 года", async () => {
    const fetchMyTrades = vi.fn().mockResolvedValue([]);
    const client = { fetchMyTrades } as unknown as Parameters<
      typeof chunkedFetchMyTrades
    >[0];
    const threeYearsAgo = Date.now() - 1095 * DAY;
    await chunkedFetchMyTrades(client, "bybit", {
      since: threeYearsAgo,
      until: Date.now(),
    });
    // Первый вызов должен пройти с since не раньше 720 дней назад
    const firstCallSince = (fetchMyTrades.mock.calls[0]?.[1] as number) ?? 0;
    const earliestAllowed = Date.now() - 720 * DAY;
    expect(firstCallSince).toBeGreaterThanOrEqual(earliestAllowed - 1000);
  });

  it("BingX cap'ит since на 180 дней назад", async () => {
    const fetchMyTrades = vi.fn().mockResolvedValue([]);
    const client = { fetchMyTrades } as unknown as Parameters<
      typeof chunkedFetchMyTrades
    >[0];
    await chunkedFetchMyTrades(client, "bingx", {
      since: Date.now() - 1095 * DAY,
      until: Date.now(),
    });
    const firstCallSince = (fetchMyTrades.mock.calls[0]?.[1] as number) ?? 0;
    const earliestAllowed = Date.now() - 180 * DAY;
    expect(firstCallSince).toBeGreaterThanOrEqual(earliestAllowed - 1000);
  });

  it("Bybit с 1095 дней default: число окон ограничено 720/7 ≈ 103 окон, не 157", async () => {
    const fetchMyTrades = vi.fn().mockResolvedValue([]);
    const client = { fetchMyTrades } as unknown as Parameters<
      typeof chunkedFetchMyTrades
    >[0];
    const r = await chunkedFetchMyTrades(client, "bybit", {
      until: Date.now(),
    });
    expect(r.windows).toBeLessThanOrEqual(Math.ceil(720 / 7) + 1);
    expect(r.windows).toBeGreaterThan(100);
  });
});

describe("chunkedFetchTransfers — B2 deposits/withdrawals chunking", () => {
  it("TRANSFER_MAX_LOOKBACK_DAYS — Bybit 720d (2y safety margin)", () => {
    expect(TRANSFER_MAX_LOOKBACK_DAYS["bybit"]).toBe(720);
  });

  it("TRANSFER_MAX_LOOKBACK_DAYS — BingX 1080d (~3 years available)", () => {
    expect(TRANSFER_MAX_LOOKBACK_DAYS["bingx"]).toBe(1080);
  });

  it("Bybit window 30d, 720d cap → ~24 окна", async () => {
    const fetchFn = vi.fn().mockResolvedValue([]);
    const r = await chunkedFetchTransfers(fetchFn, "bybit", {
      until: Date.now(),
    });
    // 720 / 30 = 24
    expect(r.windows).toBe(24);
  });

  it("BingX window 90d, 1080d cap → 12 окон", async () => {
    const fetchFn = vi.fn().mockResolvedValue([]);
    const r = await chunkedFetchTransfers(fetchFn, "bingx", {
      until: Date.now(),
    });
    expect(r.windows).toBe(12);
  });

  it("aggregator: суммирует transfers из всех окон", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce([{ id: "d1" }])
      .mockResolvedValueOnce([{ id: "d2" }, { id: "d3" }])
      .mockResolvedValue([]);
    const r = await chunkedFetchTransfers(fetchFn, "bingx", {
      since: Date.now() - 365 * DAY,
      until: Date.now(),
    });
    expect(r.items).toHaveLength(3);
  });

  it("error в одном окне не прерывает loop", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce([{ id: "d1" }])
      .mockRejectedValueOnce(new Error("rate limit"))
      .mockResolvedValue([]);
    const r = await chunkedFetchTransfers(fetchFn, "bybit", {
      since: Date.now() - 60 * DAY,
      until: Date.now(),
    });
    expect(r.items).toHaveLength(1);
    expect(r.errors).toHaveLength(1);
  });
});

describe("chunkedFetchTransfersPerAsset — B2.5 (coin-filter exchanges)", () => {
  it("TRANSFER_REQUIRES_COIN_FILTER: bybit + bingx true", () => {
    expect(TRANSFER_REQUIRES_COIN_FILTER["bybit"]).toBe(true);
    expect(TRANSFER_REQUIRES_COIN_FILTER["bingx"]).toBe(true);
    expect(TRANSFER_REQUIRES_COIN_FILTER["okx"]).toBe(false);
  });

  it("Bybit (coin-filter required) — fetcher called once per asset × windows", async () => {
    const fetchFn = vi.fn().mockResolvedValue([]);
    const r = await chunkedFetchTransfersPerAsset(
      fetchFn,
      "bybit",
      ["ETH", "USDT"],
      { since: Date.now() - 60 * DAY, until: Date.now() },
    );
    // 60d / 30d-window = 2 окна × 2 assets = 4 calls
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(r.windows).toBe(4);
    // Каждый call с правильным asset в первом аргументе
    expect(fetchFn.mock.calls[0]![0]).toBe("ETH");
    expect(fetchFn.mock.calls[2]![0]).toBe("USDT");
  });

  it("aggregator: суммирует items по всем assets", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce([{ id: "eth1" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "usdt1" }, { id: "usdt2" }])
      .mockResolvedValueOnce([]);
    const r = await chunkedFetchTransfersPerAsset(
      fetchFn,
      "bybit",
      ["ETH", "USDT"],
      { since: Date.now() - 60 * DAY, until: Date.now() },
    );
    expect(r.items).toHaveLength(3);
  });

  it("OKX (coin-filter NOT required) — fallback на chunkedFetchTransfers без iteration", async () => {
    const fetchFn = vi.fn().mockResolvedValue([]);
    const r = await chunkedFetchTransfersPerAsset(
      fetchFn,
      "okx",
      ["ETH", "USDT", "BTC"],
      { since: Date.now() - 60 * DAY, until: Date.now() },
    );
    // 60d / 90d-window = 1 окно × 1 (no per-asset iteration)
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(r.windows).toBe(1);
  });

  it("empty assets list → no calls", async () => {
    const fetchFn = vi.fn();
    const r = await chunkedFetchTransfersPerAsset(
      fetchFn,
      "bybit",
      [],
      { since: Date.now() - 60 * DAY, until: Date.now() },
    );
    expect(fetchFn).not.toHaveBeenCalled();
    expect(r.items).toEqual([]);
  });

  it("дедуп: повторяющиеся asset'ы в списке = одна итерация", async () => {
    const fetchFn = vi.fn().mockResolvedValue([]);
    await chunkedFetchTransfersPerAsset(
      fetchFn,
      "bybit",
      ["ETH", "ETH", "USDT", "ETH"], // dup ETH × 3
      { since: Date.now() - 30 * DAY, until: Date.now() },
    );
    // 30d / 30d-window = 1 window × 2 unique assets (ETH, USDT) = 2 calls
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("'does not have currency code X' — НЕ попадает в errors (graceful skip)", async () => {
    // Реальный случай Bob: Bybit отвергает unknown coins типа EOS. Не
    // должно ломать sync других assets.
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce([{ id: "eth1" }]) // ETH ok
      .mockRejectedValueOnce(new Error("bybit does not have currency code EOS")) // EOS fail
      .mockResolvedValueOnce([{ id: "usdt1" }]); // USDT ok
    const r = await chunkedFetchTransfersPerAsset(
      fetchFn,
      "bybit",
      ["ETH", "EOS", "USDT"],
      { since: Date.now() - 30 * DAY, until: Date.now() },
    );
    expect(r.items).toHaveLength(2); // eth1 + usdt1
    expect(r.errors).toHaveLength(0); // EOS error filtered out
  });

  it("persistent network errors всё ещё попадают в errors (transient retry'ит, но если оба раза fail → surface)", async () => {
    // chunkedFetch ретраит ОДИН раз на transient errors (`fetch failed`,
    // `timeout`, `ECONNRESET`, ...). Чтобы persistent error дошёл до
    // errors[] — нужно чтобы ОБА попытки fail'или. Mock первый asset
    // (ETH) fail-fail → попадает в errors. Второй (USDT) — OK.
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection timeout")) // ETH: attempt 1
      .mockRejectedValueOnce(new Error("connection timeout")) // ETH: retry
      .mockResolvedValueOnce([]); // USDT: ok
    const r = await chunkedFetchTransfersPerAsset(
      fetchFn,
      "bybit",
      ["ETH", "USDT"],
      { since: Date.now() - 30 * DAY, until: Date.now() },
    );
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.message).toMatch(/timeout/);
  });

  it("transient network blip ретраится и НЕ попадает в errors", async () => {
    // Single network blip (fetch failed once, succeeds на retry) —
    // sync теперь invisible delay вместо аборта окна. Без этого retry
    // Bitget'у достаточно одного flaky `/spot/public/coins` чтобы
    // обрушить весь deposits/withdrawals/ledger sync.
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed")) // ETH: attempt 1 transient
      .mockResolvedValueOnce([{ id: "eth1" }]) // ETH: retry → ok
      .mockResolvedValueOnce([{ id: "usdt1" }]); // USDT: ok
    const r = await chunkedFetchTransfersPerAsset(
      fetchFn,
      "bybit",
      ["ETH", "USDT"],
      { since: Date.now() - 30 * DAY, until: Date.now() },
    );
    expect(r.items).toHaveLength(2);
    expect(r.errors).toHaveLength(0);
  });
});
