/**
 * UCB D2: tests for HistoricalFxService.
 *
 * Покрываем contract API без реальных HTTP / DB calls — мокаем через
 * proxy fake DB (как в B5 tests). Upstream fetch заменяем глобальной
 * mock'ой `global.fetch`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { HistoricalFxService } from "./historical-fx.service.js";

function makeFakeDb(state: { cached?: unknown[] } = {}) {
  const captured: { inserted?: unknown[]; selectWhere?: unknown } = {};
  const chain = {
    select() {
      return this;
    },
    from() {
      return this;
    },
    insert() {
      return this;
    },
    values(v: unknown[]) {
      captured.inserted = v;
      return this;
    },
    onConflictDoNothing() {
      return Promise.resolve([]);
    },
    where(w: unknown) {
      captured.selectWhere = w;
      return this;
    },
    limit(_n: number) {
      return Promise.resolve(state.cached ?? []);
    },
    // Без limit — Promise resolves к state.cached
    then(onFulfilled: (v: unknown[]) => unknown) {
      return Promise.resolve(state.cached ?? []).then(onFulfilled);
    },
  };
  const db = {
    select: vi.fn(() => chain),
    insert: vi.fn(() => chain),
  };
  return { db: db as unknown as ConstructorParameters<typeof HistoricalFxService>[0], captured };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HistoricalFxService.getRateToUsd", () => {
  it("USD → 1 без call к БД / upstream", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const { db } = makeFakeDb();
    const svc = new HistoricalFxService(db);
    expect(await svc.getRateToUsd("USD", new Date())).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("cache hit → return cached rate без HTTP", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const { db } = makeFakeDb({ cached: [{ rate: "0.0125" }] });
    const svc = new HistoricalFxService(db);
    const r = await svc.getRateToUsd("RUB", new Date("2026-01-15"));
    expect(r).toBe(0.0125);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("cache miss → fetch upstream → cache result", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true, rates: { USD: 0.011 } }), {
          status: 200,
        }),
      );
    const { db, captured } = makeFakeDb({ cached: [] });
    const svc = new HistoricalFxService(db);
    const r = await svc.getRateToUsd("RUB", new Date("2026-01-15T12:00:00Z"));
    expect(r).toBe(0.011);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect((fetchSpy.mock.calls[0]![0] as string)).toContain("2026-01-15");
    expect((fetchSpy.mock.calls[0]![0] as string)).toContain("base=RUB");
    expect(captured.inserted).toBeDefined();
  });

  it("upstream returns invalid rate → null без cache write", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, rates: { USD: null } }), {
        status: 200,
      }),
    );
    const { db, captured } = makeFakeDb({ cached: [] });
    const svc = new HistoricalFxService(db);
    expect(await svc.getRateToUsd("XYZ", new Date())).toBeNull();
    expect(captured.inserted).toBeUndefined();
  });

  it("upstream timeout / error → null gracefully", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("net err"));
    const { db } = makeFakeDb({ cached: [] });
    const svc = new HistoricalFxService(db);
    expect(await svc.getRateToUsd("RUB", new Date())).toBeNull();
  });
});

describe("HistoricalFxService.batchGetRates", () => {
  it("empty needs → empty map", async () => {
    const { db } = makeFakeDb();
    const svc = new HistoricalFxService(db);
    const r = await svc.batchGetRates([]);
    expect(r.size).toBe(0);
  });

  it("USD-only need → no HTTP / DB", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const { db } = makeFakeDb();
    const svc = new HistoricalFxService(db);
    const r = await svc.batchGetRates([
      { currency: "USD", date: new Date("2026-01-01") },
    ]);
    expect(r.size).toBe(1);
    expect(r.get("USD|2026-01-01")).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("HistoricalFxService.keyOf", () => {
  it("формирует стабильный composite key", () => {
    expect(
      HistoricalFxService.keyOf("rub", new Date("2026-01-15T12:34:56Z")),
    ).toBe("RUB|2026-01-15");
  });
});
