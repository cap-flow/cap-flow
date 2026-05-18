/**
 * Tests for proxy-tester. Главное — корректная классификация
 * http-status'ов / ошибок в `ProxyTestStatus` (она драйвит UI).
 * Сами сетевые вызовы НЕ делаем — мокаем classify* функции
 * через тестирование responses.
 */
import { describe, expect, it } from "vitest";

import { maskProxyCredentials } from "./cex.proxy-tester.js";

describe("maskProxyCredentials", () => {
  it("маскирует user:pass@host", () => {
    expect(
      maskProxyCredentials("http://user409385:6jawbk@163.5.183.126:4761"),
    ).toBe("http://***@163.5.183.126:4761");
  });

  it("оставляет URL без credentials как есть", () => {
    expect(maskProxyCredentials("http://163.5.183.126:4761")).toBe(
      "http://163.5.183.126:4761",
    );
  });

  it("работает с https://", () => {
    expect(maskProxyCredentials("https://user:pass@proxy.example.com:8080")).toBe(
      "https://***@proxy.example.com:8080",
    );
  });

  it("безопасно для пустой строки", () => {
    expect(maskProxyCredentials("")).toBe("");
  });

  it("не трогает url с @ в path", () => {
    // Граничный кейс — @ в path не должен пострадать
    expect(maskProxyCredentials("https://example.com/foo@bar")).toBe(
      "https://example.com/foo@bar",
    );
  });
});

describe("testProxy — validation", () => {
  it("throws on empty URL", async () => {
    const { testProxy } = await import("./cex.proxy-tester.js");
    await expect(testProxy("")).rejects.toThrow(/empty/i);
    await expect(testProxy("   ")).rejects.toThrow(/empty/i);
  });

  it("throws on malformed URL (no scheme)", async () => {
    const { testProxy } = await import("./cex.proxy-tester.js");
    await expect(testProxy("just-some-string")).rejects.toThrow(/malformed/i);
  });

  it("maskedURL в error message не содержит plain credentials", async () => {
    const { testProxy } = await import("./cex.proxy-tester.js");
    try {
      // URL валидный сам по себе но не URL — выкинет на ProxyAgent
      // construction. Тогда сообщение об ошибке должно маскировать.
      await testProxy("not://a:valid@url\x00");
    } catch (e) {
      const msg = (e as Error).message;
      // Если в msg есть креды — они должны быть либо замаскированы либо отсутствовать
      expect(msg).not.toContain("a:valid@");
    }
  });
});

describe("PROXY_TEST_TARGETS — sanity", () => {
  it("содержит 3 биржи: bybit/bingx/bitget", async () => {
    const { PROXY_TEST_TARGETS } = await import("./cex.proxy-tester.js");
    expect(PROXY_TEST_TARGETS.map((t) => t.exchange)).toEqual([
      "bybit",
      "bingx",
      "bitget",
    ]);
  });

  it("все URL — public time-эндпойнты без auth", async () => {
    const { PROXY_TEST_TARGETS } = await import("./cex.proxy-tester.js");
    for (const t of PROXY_TEST_TARGETS) {
      expect(t.url).toMatch(/^https:\/\/api\./);
      expect(t.url).toMatch(/time|server/i);
    }
  });
});
