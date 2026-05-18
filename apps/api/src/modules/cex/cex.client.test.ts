import { describe, expect, it, vi } from "vitest";

import { createCexClient, normalizeBalance, normalizeTrade } from "./cex.client.js";
import type { CexCredentials } from "./cex.types.js";

/**
 * CexClient is a thin adapter over CCXT. The unit tests here focus on
 * the OUR contract (normalization + safety checks), not CCXT internals
 * — we mock the CCXT instance so the tests are deterministic and don't
 * hit real exchanges.
 */

describe("createCexClient — supported exchanges", () => {
  const creds: CexCredentials = {
    apiKey: "k",
    apiSecret: "s",
    apiPassphrase: "p",
  };

  it("creates a Bybit client without throwing", () => {
    const c = createCexClient("bybit", creds);
    expect(c).toBeDefined();
    expect(c.id).toBe("bybit");
  });

  it("creates an OKX client (passphrase required and supplied)", () => {
    const c = createCexClient("okx", creds);
    expect(c.id).toBe("okx");
  });

  it("creates a Bitget client (passphrase required and supplied)", () => {
    const c = createCexClient("bitget", creds);
    expect(c.id).toBe("bitget");
  });

  it("creates an MEXC client", () => {
    const c = createCexClient("mexc", creds);
    expect(c.id).toBe("mexc");
  });

  it("creates a BingX client (no passphrase needed)", () => {
    const c = createCexClient("bingx", {
      apiKey: "k",
      apiSecret: "s",
    });
    expect(c.id).toBe("bingx");
  });

  it("throws on OKX without passphrase", () => {
    expect(() =>
      createCexClient("okx", { apiKey: "k", apiSecret: "s" })
    ).toThrow(/passphrase/i);
  });

  it("throws on Bitget without passphrase", () => {
    expect(() =>
      createCexClient("bitget", { apiKey: "k", apiSecret: "s" })
    ).toThrow(/passphrase/i);
  });

  it("Bybit / MEXC accept missing passphrase", () => {
    expect(() =>
      createCexClient("bybit", { apiKey: "k", apiSecret: "s" })
    ).not.toThrow();
    expect(() =>
      createCexClient("mexc", { apiKey: "k", apiSecret: "s" })
    ).not.toThrow();
  });

  it("enables CCXT rate limiting (per-exchange throttle)", () => {
    const c = createCexClient("bybit", creds);
    // `enableRateLimit` is the CCXT switch that throttles to advertised
    // public rate limits. We want it ON to avoid getting banned.
    expect(c.enableRateLimit).toBe(true);
  });
});

describe("normalizeBalance — flatten CCXT shape to ledger rows", () => {
  it("emits one row per non-zero asset", () => {
    const ccxtShape = {
      BTC: { free: 0.5, used: 0.1, total: 0.6 },
      USDT: { free: 1000, used: 0, total: 1000 },
      ETH: { free: 0, used: 0, total: 0 },
    };
    const rows = normalizeBalance(ccxtShape, "spot");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.asset).sort()).toEqual(["BTC", "USDT"]);
    expect(rows.every((r) => r.accountType === "spot")).toBe(true);
  });

  it("preserves precise numbers (no float-truncate surprises)", () => {
    const rows = normalizeBalance(
      { BTC: { free: 0.12345678, used: 0, total: 0.12345678 } },
      "spot"
    );
    expect(rows[0]!.total).toBe(0.12345678);
  });

  it("skips meta-fields that CCXT mixes in (info, free, used, total)", () => {
    // CCXT returns the per-asset map alongside meta-fields like `info`
    // (raw exchange response). We must not treat those as assets.
    const ccxtShape = {
      BTC: { free: 1, used: 0, total: 1 },
      info: { raw: "..." } as unknown as { free: number; used: number; total: number },
      timestamp: 1700000000000 as unknown as { free: number; used: number; total: number },
    };
    const rows = normalizeBalance(ccxtShape, "spot");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.asset).toBe("BTC");
  });

  it("propagates accountType label (spot / futures / margin)", () => {
    const rows = normalizeBalance(
      { USDT: { free: 100, used: 0, total: 100 } },
      "futures"
    );
    expect(rows[0]!.accountType).toBe("futures");
  });
});

describe("normalizeTrade — CCXT trade → CexTradeLine", () => {
  it("maps standard CCXT trade shape", () => {
    const ccxt = {
      id: "T123",
      symbol: "BTC/USDT",
      side: "buy" as const,
      amount: 0.5,
      price: 50000,
      cost: 25000,
      fee: { currency: "USDT", cost: 25 },
      takerOrMaker: "taker" as const,
      timestamp: 1700000000000,
    };
    const r = normalizeTrade(ccxt);
    expect(r).toEqual({
      id: "T123",
      symbol: "BTC/USDT",
      side: "buy",
      amount: 0.5,
      price: 50000,
      cost: 25000,
      fee: { currency: "USDT", cost: 25 },
      takerOrMaker: "taker",
      executedAtMs: 1700000000000,
    });
  });

  it("synthesizes cost when CCXT omits it", () => {
    const r = normalizeTrade({
      id: "T1",
      symbol: "ETH/USDT",
      side: "sell" as const,
      amount: 2,
      price: 3000,
      timestamp: 1700000000000,
    });
    expect(r!.cost).toBe(6000);
  });

  it("returns null for trades missing critical fields", () => {
    expect(
      normalizeTrade({
        id: "",
        symbol: "BTC/USDT",
        side: "buy" as const,
        amount: 1,
        price: 50000,
        timestamp: 0,
      })
    ).toBeNull();
    expect(
      normalizeTrade({
        id: "T1",
        symbol: "BTC/USDT",
        side: "buy" as const,
        amount: 0,
        price: 50000,
        timestamp: 1700000000000,
      })
    ).toBeNull();
  });
});

describe("CexClient.probePermissions — read/trade/withdraw audit (legacy fields)", () => {
  it("returns read:true when fetchBalance succeeds", async () => {
    const c = createCexClient("bybit", {
      apiKey: "k",
      apiSecret: "s",
    });
    // Mock fetchBalance to succeed.
    vi.spyOn(c, "fetchBalance" as never).mockResolvedValue(
      {} as never
    );
    // Stub data-read endpoints as unsupported so they don't hit network.
    (c as { has: Record<string, boolean> }).has = {
      ...(c as { has?: Record<string, boolean> }).has,
      fetchMyTrades: false,
      fetchDeposits: false,
      fetchWithdrawals: false,
    };

    const perms = await c.probePermissions();
    expect(perms.read).toBe(true);
    // `trade` and `withdraw` are MUST-BE-FALSE markers — Capflow is
    // read-only, we don't probe write-permissions. Keep these false.
    expect(perms.trade).toBe(false);
    expect(perms.withdraw).toBe(false);
  });

  it("returns read:false when fetchBalance throws (bad/no key)", async () => {
    const c = createCexClient("bybit", {
      apiKey: "k",
      apiSecret: "s",
    });
    vi.spyOn(c, "fetchBalance" as never).mockRejectedValue(
      new Error("Authentication failed")
    );

    const perms = await c.probePermissions();
    expect(perms.read).toBe(false);
    expect(perms.trade).toBe(false);
    expect(perms.withdraw).toBe(false);
  });
});

/* ─── B1.1: real probe of data-read permissions ─── */

/**
 * `PermStatus` semantics:
 *   ok          — endpoint работает (даже если empty response)
 *   denied      — explicit 401/403/«permission»/«unauthorized»
 *   unsupported — CCXT не имеет такого method'а для этой биржи
 *   unknown     — probe не запускался, transient error (network/timeout)
 *
 * Зачем enum вместо boolean: B4 «Sync coverage report UI» должен
 * различать «не пробовали» vs «биржа явно запретила». Без enum мы
 * сваливаем оба случая в `false` и UI не может дать точный совет.
 */
describe("CexClient.probePermissions — data-read endpoints (tradeHistory / deposits / withdrawals)", () => {
  function makeClient() {
    return createCexClient("bybit", { apiKey: "k", apiSecret: "s" });
  }

  function stubHas(
    c: ReturnType<typeof makeClient>,
    overrides: Record<string, boolean>,
  ): void {
    (c as { has: Record<string, boolean> }).has = {
      ...(c as { has?: Record<string, boolean> }).has,
      ...overrides,
    };
  }

  it("tradeHistory='ok' when fetchMyTrades returns empty array", async () => {
    const c = makeClient();
    vi.spyOn(c, "fetchBalance" as never).mockResolvedValue({} as never);
    stubHas(c, { fetchMyTrades: true, fetchDeposits: false, fetchWithdrawals: false });
    vi.spyOn(c, "fetchMyTrades" as never).mockResolvedValue([] as never);

    const perms = await c.probePermissions();
    expect(perms.tradeHistory).toBe("ok");
  });

  it("tradeHistory='ok' when fetchMyTrades throws 'requires symbol' (works, just needs symbol)", async () => {
    const c = makeClient();
    vi.spyOn(c, "fetchBalance" as never).mockResolvedValue({} as never);
    stubHas(c, { fetchMyTrades: true, fetchDeposits: false, fetchWithdrawals: false });
    vi.spyOn(c, "fetchMyTrades" as never).mockRejectedValue(
      new Error("bybit fetchMyTrades() requires a symbol argument"),
    );

    const perms = await c.probePermissions();
    expect(perms.tradeHistory).toBe("ok");
  });

  it("tradeHistory='denied' when fetchMyTrades throws permission error", async () => {
    const c = makeClient();
    vi.spyOn(c, "fetchBalance" as never).mockResolvedValue({} as never);
    stubHas(c, { fetchMyTrades: true, fetchDeposits: false, fetchWithdrawals: false });
    vi.spyOn(c, "fetchMyTrades" as never).mockRejectedValue(
      new Error("403 Forbidden: permission denied for this endpoint"),
    );

    const perms = await c.probePermissions();
    expect(perms.tradeHistory).toBe("denied");
  });

  it("tradeHistory='denied' on 'unauthorized'", async () => {
    const c = makeClient();
    vi.spyOn(c, "fetchBalance" as never).mockResolvedValue({} as never);
    stubHas(c, { fetchMyTrades: true, fetchDeposits: false, fetchWithdrawals: false });
    vi.spyOn(c, "fetchMyTrades" as never).mockRejectedValue(
      new Error("401 unauthorized"),
    );

    const perms = await c.probePermissions();
    expect(perms.tradeHistory).toBe("denied");
  });

  it("tradeHistory='unsupported' when CCXT doesn't have fetchMyTrades", async () => {
    const c = makeClient();
    vi.spyOn(c, "fetchBalance" as never).mockResolvedValue({} as never);
    stubHas(c, { fetchMyTrades: false, fetchDeposits: false, fetchWithdrawals: false });

    const perms = await c.probePermissions();
    expect(perms.tradeHistory).toBe("unsupported");
  });

  it("tradeHistory='unknown' on network/timeout error (transient)", async () => {
    const c = makeClient();
    vi.spyOn(c, "fetchBalance" as never).mockResolvedValue({} as never);
    stubHas(c, { fetchMyTrades: true, fetchDeposits: false, fetchWithdrawals: false });
    vi.spyOn(c, "fetchMyTrades" as never).mockRejectedValue(
      new Error("request timed out (60000 ms)"),
    );

    const perms = await c.probePermissions();
    expect(perms.tradeHistory).toBe("unknown");
  });

  it("deposits and withdrawals probed independently of trades", async () => {
    const c = makeClient();
    vi.spyOn(c, "fetchBalance" as never).mockResolvedValue({} as never);
    stubHas(c, {
      fetchMyTrades: true,
      fetchDeposits: true,
      fetchWithdrawals: true,
    });
    vi.spyOn(c, "fetchMyTrades" as never).mockResolvedValue([] as never);
    vi.spyOn(c, "fetchDeposits" as never).mockRejectedValue(
      new Error("permission denied"),
    );
    vi.spyOn(c, "fetchWithdrawals" as never).mockResolvedValue([] as never);

    const perms = await c.probePermissions();
    expect(perms.tradeHistory).toBe("ok");
    expect(perms.deposits).toBe("denied");
    expect(perms.withdrawals).toBe("ok");
  });

  it("lastProbedAt is set to an ISO timestamp on every probe", async () => {
    const c = makeClient();
    vi.spyOn(c, "fetchBalance" as never).mockResolvedValue({} as never);
    stubHas(c, { fetchMyTrades: false, fetchDeposits: false, fetchWithdrawals: false });

    const before = Date.now();
    const perms = await c.probePermissions();
    const after = Date.now();
    expect(perms.lastProbedAt).toBeDefined();
    const t = Date.parse(perms.lastProbedAt!);
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });

  it("if read=false (bad key), all data-read endpoints are 'unknown' (didn't bother probing)", async () => {
    const c = makeClient();
    vi.spyOn(c, "fetchBalance" as never).mockRejectedValue(
      new Error("Authentication failed"),
    );

    const perms = await c.probePermissions();
    expect(perms.read).toBe(false);
    expect(perms.tradeHistory).toBe("unknown");
    expect(perms.deposits).toBe("unknown");
    expect(perms.withdrawals).toBe("unknown");
  });

  it("tradeHistory probe handles 'IP not whitelisted' as denied (typical BingX 100410)", async () => {
    // Реальный сценарий BingX: ключ ok, но IP сервера не в whitelist
    // на бирже. Биржа возвращает что-то типа `100410 IP not allowed`.
    const c = makeClient();
    vi.spyOn(c, "fetchBalance" as never).mockResolvedValue({} as never);
    stubHas(c, { fetchMyTrades: true, fetchDeposits: false, fetchWithdrawals: false });
    vi.spyOn(c, "fetchMyTrades" as never).mockRejectedValue(
      new Error("100410 IP whitelist required"),
    );

    const perms = await c.probePermissions();
    expect(perms.tradeHistory).toBe("denied");
  });
});
