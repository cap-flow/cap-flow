import { afterEach, describe, expect, it, vi } from "vitest";

import { apiFetch, setApiConcurrencyLimit } from "./client";

const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * Мок fetch, который «зависает» до ручного резолва — позволяет замерить,
 * сколько запросов реально летят одновременно.
 */
function makeGatedFetch() {
  let inFlight = 0;
  let maxConcurrent = 0;
  const gates: Array<() => void> = [];
  const fn = vi.fn(() => {
    inFlight += 1;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    return new Promise<unknown>((resolve) => {
      gates.push(() => {
        inFlight -= 1;
        resolve({ status: 200, ok: true } as unknown);
      });
    });
  });
  return {
    fn,
    releaseAll: () => {
      while (gates.length) gates.shift()!();
    },
    get maxConcurrent() {
      return maxConcurrent;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  setApiConcurrencyLimit(4); // вернуть дефолт
});

describe("upstream concurrency limiter", () => {
  it("ограничивает одновременные upstream-запросы заданным лимитом", async () => {
    setApiConcurrencyLimit(2);
    const gated = makeGatedFetch();
    vi.stubGlobal("fetch", gated.fn);

    const calls = Array.from({ length: 6 }, () =>
      apiFetch("/v1/upstream/debank/v1/user/total_balance"),
    );
    await flush();

    // Только 2 в полёте, остальные 4 в очереди.
    expect(gated.fn).toHaveBeenCalledTimes(2);
    expect(gated.maxConcurrent).toBeLessThanOrEqual(2);

    gated.releaseAll();
    await flush();
    gated.releaseAll();
    await flush();
    gated.releaseAll();
    await Promise.all(calls);

    expect(gated.fn).toHaveBeenCalledTimes(6); // все прошли
    expect(gated.maxConcurrent).toBeLessThanOrEqual(2); // но пик ≤ 2
  });

  it("лимит 1 → строго по очереди", async () => {
    setApiConcurrencyLimit(1);
    const gated = makeGatedFetch();
    vi.stubGlobal("fetch", gated.fn);

    const calls = Array.from({ length: 3 }, () =>
      apiFetch("/v1/upstream/helius/v0/x"),
    );
    await flush();
    expect(gated.fn).toHaveBeenCalledTimes(1);

    gated.releaseAll();
    await flush();
    gated.releaseAll();
    await flush();
    gated.releaseAll();
    await Promise.all(calls);
    expect(gated.maxConcurrent).toBe(1);
  });

  it("внутренний app-API (не /v1/upstream/) НЕ троттлится", async () => {
    setApiConcurrencyLimit(1);
    const gated = makeGatedFetch();
    vi.stubGlobal("fetch", gated.fn);

    const calls = [
      apiFetch("/v1/me/app-config"),
      apiFetch("/v1/me/feature-flags"),
      apiFetch("/v1/me/x"),
    ];
    await flush();
    // Все 3 ушли сразу — семафор их не держит.
    expect(gated.fn).toHaveBeenCalledTimes(3);

    gated.releaseAll();
    await Promise.all(calls);
  });
});
