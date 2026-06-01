/**
 * Krystal client retry/backoff (POS-007 follow-up, 2026-05-31).
 *
 * api_usage показал 240× HTTP 429 (rate_limited) на рефреше → fee у Krystal-LP
 * прерывисто падал в «—» (override пропускался). krystalFetchWithRetry ретраит
 * transient 429/503 с backoff, чтобы transient rate-limit не ронял fee.
 */
import { describe, expect, it, vi } from "vitest";

import { krystalFetchWithRetry, parseRetryAfterMs } from "./client";

function resp(status: number, retryAfter?: string): Response {
  const headers = new Headers();
  if (retryAfter != null) headers.set("Retry-After", retryAfter);
  return new Response(null, { status, headers });
}

const noSleep = vi.fn(async () => {});

describe("krystalFetchWithRetry", () => {
  it("200 → без ретрая (один вызов)", async () => {
    const fetchImpl = vi.fn(async () => resp(200));
    const res = await krystalFetchWithRetry("/p", {}, { fetchImpl, sleep: noSleep });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("429 затем 200 → ретрай, возвращает 200", async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi
      .fn<[], Promise<Response>>()
      .mockResolvedValueOnce(resp(429))
      .mockResolvedValueOnce(resp(200));
    const res = await krystalFetchWithRetry("/p", {}, { fetchImpl, sleep });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("503 ретраится так же", async () => {
    const fetchImpl = vi
      .fn<[], Promise<Response>>()
      .mockResolvedValueOnce(resp(503))
      .mockResolvedValueOnce(resp(200));
    const res = await krystalFetchWithRetry("/p", {}, { fetchImpl, sleep: noSleep });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("429 дольше лимита попыток → отдаёт последний 429 (graceful)", async () => {
    const fetchImpl = vi.fn(async () => resp(429));
    const res = await krystalFetchWithRetry("/p", {}, { fetchImpl, sleep: noSleep });
    expect(res.status).toBe(429);
    // MAX_RETRY_ATTEMPTS=3 → 1 initial + 3 retries = 4 вызова
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("401 → НЕ ретраит (постоянная ошибка, один вызов)", async () => {
    const fetchImpl = vi.fn(async () => resp(401));
    const res = await krystalFetchWithRetry("/p", {}, { fetchImpl, sleep: noSleep });
    expect(res.status).toBe(401);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("уважает Retry-After (секунды) для задержки", async () => {
    const sleeps: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleeps.push(ms);
    });
    const fetchImpl = vi
      .fn<[], Promise<Response>>()
      .mockResolvedValueOnce(resp(429, "2"))
      .mockResolvedValueOnce(resp(200));
    await krystalFetchWithRetry("/p", {}, { fetchImpl, sleep });
    expect(sleeps[0]).toBe(2000); // 2s
  });

  it("экспоненциальный backoff без Retry-After: 300 → 600", async () => {
    const sleeps: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleeps.push(ms);
    });
    const fetchImpl = vi
      .fn<[], Promise<Response>>()
      .mockResolvedValueOnce(resp(429))
      .mockResolvedValueOnce(resp(429))
      .mockResolvedValueOnce(resp(200));
    await krystalFetchWithRetry("/p", {}, { fetchImpl, sleep });
    expect(sleeps).toEqual([300, 600]);
  });
});

describe("parseRetryAfterMs", () => {
  it("число секунд → ms", () => {
    expect(parseRetryAfterMs("5")).toBe(5000);
  });
  it("ноль/отсутствует → null", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("")).toBeNull();
  });
  it("мусор → null", () => {
    expect(parseRetryAfterMs("soon")).toBeNull();
  });
  it("кап на 60s", () => {
    expect(parseRetryAfterMs("9999")).toBe(60_000);
  });
});
