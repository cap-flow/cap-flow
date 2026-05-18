/**
 * Tests for the CSRF helper used by the web client (2026-05-18).
 *
 * No DOM — vitest's default node env. We stub `globalThis.document`
 * and `globalThis.localStorage` to mimic just enough of the browser.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  purgeLegacyAuthStorage,
  readCsrfToken,
} from "./csrf";

interface MutableGlobal {
  document?: { cookie: string };
  localStorage?: {
    store: Record<string, string>;
    getItem(k: string): string | null;
    setItem(k: string, v: string): void;
    removeItem(k: string): void;
  };
}

function setCookie(value: string): void {
  (globalThis as MutableGlobal).document = { cookie: value };
}

function clearCookie(): void {
  delete (globalThis as MutableGlobal).document;
}

function mountLocalStorage(initial: Record<string, string>): void {
  const store: Record<string, string> = { ...initial };
  (globalThis as MutableGlobal).localStorage = {
    store,
    getItem(k: string) {
      return Object.prototype.hasOwnProperty.call(store, k) ? store[k]! : null;
    },
    setItem(k: string, v: string) {
      store[k] = v;
    },
    removeItem(k: string) {
      delete store[k];
    },
  };
}

function clearLocalStorage(): void {
  delete (globalThis as MutableGlobal).localStorage;
}

describe("readCsrfToken", () => {
  afterEach(() => {
    clearCookie();
  });

  it("returns null when document is undefined (SSR)", () => {
    expect(readCsrfToken()).toBeNull();
  });

  it("returns null when no cap_csrf cookie is set", () => {
    setCookie("foo=bar; theme=dark");
    expect(readCsrfToken()).toBeNull();
  });

  it("extracts the token from a single-cookie string", () => {
    setCookie(`${CSRF_COOKIE_NAME}=abc123def`);
    expect(readCsrfToken()).toBe("abc123def");
  });

  it("extracts the token among other cookies, with whitespace", () => {
    setCookie(`theme=dark;  ${CSRF_COOKIE_NAME}=xyz789 ;  foo=bar`);
    expect(readCsrfToken()).toBe("xyz789");
  });

  it("returns null when cap_csrf is set but empty", () => {
    setCookie(`theme=dark; ${CSRF_COOKIE_NAME}=`);
    expect(readCsrfToken()).toBeNull();
  });

  it("does not partial-match (e.g. cap_csrf_other)", () => {
    setCookie("cap_csrf_other=notme");
    expect(readCsrfToken()).toBeNull();
  });

  it("CSRF_HEADER_NAME is the canonical header name", () => {
    expect(CSRF_HEADER_NAME).toBe("X-CSRF-Token");
  });
});

describe("purgeLegacyAuthStorage", () => {
  beforeEach(() => {
    clearLocalStorage();
  });
  afterEach(() => {
    clearLocalStorage();
  });

  it("no-ops when localStorage is unavailable", () => {
    expect(() => purgeLegacyAuthStorage()).not.toThrow();
  });

  it("removes the legacy auth keys when present", () => {
    mountLocalStorage({
      "cap.accessToken": "old-jwt",
      "cap.refreshToken": "old-refresh",
      "capflow.accessToken": "older",
      "auth.refreshToken": "very-old",
      "user-pref": "keep-me",
    });
    purgeLegacyAuthStorage();
    const store = (globalThis as MutableGlobal).localStorage!.store;
    expect(store["cap.accessToken"]).toBeUndefined();
    expect(store["cap.refreshToken"]).toBeUndefined();
    expect(store["capflow.accessToken"]).toBeUndefined();
    expect(store["auth.refreshToken"]).toBeUndefined();
    // Unrelated keys preserved.
    expect(store["user-pref"]).toBe("keep-me");
  });
});
