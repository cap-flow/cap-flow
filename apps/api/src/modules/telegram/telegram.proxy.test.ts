import { describe, expect, it } from "vitest";

import {
  loadTelegramProxyConfig,
  TelegramProxyState,
} from "./telegram.proxy.js";

const stubLog = {
  warn: () => {},
  error: () => {},
  info: () => {},
} as never;

describe("loadTelegramProxyConfig", () => {
  it("parses http URL → dispatcher built, kind=http", () => {
    const cfg = loadTelegramProxyConfig("http://user:pass@host:8080");
    expect(cfg).not.toBeNull();
    expect(cfg!.kind).toBe("http");
    expect(cfg!.dispatcher).not.toBeNull();
    expect(cfg!.url).toBe("http://user:pass@host:8080");
  });

  it("parses https URL → kind=https, dispatcher built", () => {
    const cfg = loadTelegramProxyConfig("https://host:8443");
    expect(cfg!.kind).toBe("https");
    expect(cfg!.dispatcher).not.toBeNull();
  });

  it("socks5 URL → kind=socks, custom undici Agent built", () => {
    const cfg = loadTelegramProxyConfig("socks5://host:1080");
    expect(cfg!.kind).toBe("socks");
    expect(cfg!.dispatcher).not.toBeNull();
  });

  it("socks5h URL → kind=socks, custom undici Agent built", () => {
    const cfg = loadTelegramProxyConfig(
      "socks5h://user:pass@host.example:43517",
    );
    expect(cfg!.kind).toBe("socks");
    expect(cfg!.dispatcher).not.toBeNull();
  });

  it("socks4 URL → kind=socks, custom undici Agent built", () => {
    const cfg = loadTelegramProxyConfig("socks4://host:1080");
    expect(cfg!.kind).toBe("socks");
    expect(cfg!.dispatcher).not.toBeNull();
  });

  it("malformed SOCKS URL (no port) → throws", () => {
    expect(() => loadTelegramProxyConfig("socks5://host")).toThrow();
  });

  it("empty/null → returns null", () => {
    expect(loadTelegramProxyConfig(null)).toBeNull();
    expect(loadTelegramProxyConfig("")).toBeNull();
    expect(loadTelegramProxyConfig("   ")).toBeNull();
  });

  it("trims whitespace from URL", () => {
    const cfg = loadTelegramProxyConfig("  http://host:80  ");
    expect(cfg!.url).toBe("http://host:80");
  });
});

describe("TelegramProxyState", () => {
  it("DB value wins over env fallback", async () => {
    const state = new TelegramProxyState(
      "http://env:80",
      async () => "http://db:80",
      stubLog,
    );
    await state.refresh();
    expect(state.currentSync()?.url).toBe("http://db:80");
  });

  it("falls back to env when DB returns null", async () => {
    const state = new TelegramProxyState(
      "http://env:80",
      async () => null,
      stubLog,
    );
    await state.refresh();
    expect(state.currentSync()?.url).toBe("http://env:80");
  });

  it("no env, no DB → currentSync() is null", async () => {
    const state = new TelegramProxyState(
      null,
      async () => null,
      stubLog,
    );
    await state.refresh();
    expect(state.currentSync()).toBeNull();
  });

  it("DB throws → falls back to env (silent)", async () => {
    const state = new TelegramProxyState(
      "http://env:80",
      async () => {
        throw new Error("boom");
      },
      stubLog,
    );
    await state.refresh();
    expect(state.currentSync()?.url).toBe("http://env:80");
  });

  it("refresh() picks up updated DB value on second call", async () => {
    let dbValue = "http://first:80";
    const state = new TelegramProxyState(
      null,
      async () => dbValue,
      stubLog,
    );
    await state.refresh();
    expect(state.currentSync()?.url).toBe("http://first:80");

    dbValue = "http://second:80";
    await state.refresh();
    expect(state.currentSync()?.url).toBe("http://second:80");
  });

  it("currentSync() before refresh() returns null (no auto-load)", () => {
    const state = new TelegramProxyState(
      "http://env:80",
      async () => null,
      stubLog,
    );
    expect(state.currentSync()).toBeNull();
  });
});
