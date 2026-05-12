import { describe, expect, it } from "vitest";

import {
  InMemoryRateLimitStore,
  UpstreamRateLimitService,
} from "./rate-limit.js";

function svc(opts?: {
  perMinute?: number;
  perHour?: number;
  clock?: () => number;
}) {
  const store = new InMemoryRateLimitStore();
  const clock = opts?.clock ?? (() => 0);
  return new UpstreamRateLimitService(store, {
    perMinute: opts?.perMinute ?? 3,
    perHour: opts?.perHour ?? 10,
    clock,
  });
}

describe("UpstreamRateLimitService — under limit", () => {
  it("allows requests below per-minute limit; counts remaining", async () => {
    const rl = svc({ perMinute: 3, perHour: 10 });
    const r1 = await rl.check("user-1");
    expect(r1).toMatchObject({ allowed: true, remainingMinute: 2 });
    const r2 = await rl.check("user-1");
    expect(r2.remainingMinute).toBe(1);
    const r3 = await rl.check("user-1");
    expect(r3.remainingMinute).toBe(0);
    expect(r3.allowed).toBe(true);
  });
});

describe("UpstreamRateLimitService — per-minute limit", () => {
  it("rejects the 4th request when minute-limit is 3", async () => {
    const rl = svc({ perMinute: 3, perHour: 100 });
    await rl.check("user-1");
    await rl.check("user-1");
    await rl.check("user-1");
    const r = await rl.check("user-1");
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSeconds).toBeGreaterThan(0);
    expect(r.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("isolates users (one user's spam does not block another)", async () => {
    const rl = svc({ perMinute: 2, perHour: 10 });
    await rl.check("user-A");
    await rl.check("user-A");
    expect((await rl.check("user-A")).allowed).toBe(false);
    expect((await rl.check("user-B")).allowed).toBe(true);
  });

  it("releases the limit after the minute window rolls over", async () => {
    let now = 1_000_000;
    const rl = svc({ perMinute: 2, perHour: 100, clock: () => now });
    await rl.check("u1");
    await rl.check("u1");
    expect((await rl.check("u1")).allowed).toBe(false);
    // Advance past minute boundary.
    now += 61_000;
    const r = await rl.check("u1");
    expect(r.allowed).toBe(true);
    expect(r.remainingMinute).toBe(1);
  });
});

describe("UpstreamRateLimitService — per-hour limit", () => {
  it("rejects when hour-cap is hit even if minute-cap is fresh", async () => {
    let now = 1_000_000;
    const rl = svc({ perMinute: 100, perHour: 3, clock: () => now });
    await rl.check("u1");
    now += 30_000;
    await rl.check("u1");
    now += 30_000;
    await rl.check("u1");
    now += 30_000;
    const r = await rl.check("u1");
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSeconds).toBeGreaterThan(60);
  });

  it("releases hour-cap after window rolls over", async () => {
    let now = 1_000_000;
    const rl = svc({ perMinute: 100, perHour: 2, clock: () => now });
    await rl.check("u1");
    await rl.check("u1");
    expect((await rl.check("u1")).allowed).toBe(false);
    now += 3_600_001;
    expect((await rl.check("u1")).allowed).toBe(true);
  });
});

describe("UpstreamRateLimitService — retry-after math", () => {
  it("returns seconds until window expiry on minute reject", async () => {
    let now = 1_000_000;
    const rl = svc({ perMinute: 1, perHour: 100, clock: () => now });
    await rl.check("u1");
    const r = await rl.check("u1");
    expect(r.allowed).toBe(false);
    // Minute bucket = floor(1_000_000/60000) * 60000 = 960_000.
    // Expiry at 960_000 + 60_000 = 1_020_000.
    // Retry-after = ceil((1_020_000 - 1_000_000) / 1000) = 20.
    expect(r.retryAfterSeconds).toBe(20);
  });
});

describe("InMemoryRateLimitStore — TTL/expiry semantics", () => {
  it("expired keys are not counted", async () => {
    let now = 1_000_000;
    const store = new InMemoryRateLimitStore(() => now);
    expect(await store.incrAndExpire("k", 60)).toBe(1);
    expect(await store.incrAndExpire("k", 60)).toBe(2);
    now += 61_000;
    expect(await store.incrAndExpire("k", 60)).toBe(1);
  });
});
