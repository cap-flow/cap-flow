import { describe, expect, it } from "vitest";

import { ACCESS_COOKIE_NAME, extractAccessToken } from "./auth.cookies.js";

function req(opts: {
  authorization?: string;
  cookies?: Record<string, string>;
}) {
  return {
    headers: opts.authorization ? { authorization: opts.authorization } : {},
    cookies: opts.cookies ?? {},
  };
}

describe("extractAccessToken", () => {
  it("returns the Bearer token when header is present", () => {
    expect(
      extractAccessToken(req({ authorization: "Bearer abc.xyz.123" }))
    ).toBe("abc.xyz.123");
  });

  it("trims whitespace after 'Bearer '", () => {
    expect(
      extractAccessToken(req({ authorization: "Bearer    foo.bar.baz   " }))
    ).toBe("foo.bar.baz");
  });

  it("ignores non-Bearer Authorization schemes", () => {
    expect(
      extractAccessToken(req({ authorization: "Basic dXNlcjpwYXNz" }))
    ).toBeNull();
  });

  it("falls back to the access cookie when Bearer absent", () => {
    expect(
      extractAccessToken(
        req({ cookies: { [ACCESS_COOKIE_NAME]: "cookie.jwt.value" } })
      )
    ).toBe("cookie.jwt.value");
  });

  it("Bearer wins over cookie when both present", () => {
    expect(
      extractAccessToken(
        req({
          authorization: "Bearer header.jwt.value",
          cookies: { [ACCESS_COOKIE_NAME]: "cookie.jwt.value" },
        })
      )
    ).toBe("header.jwt.value");
  });

  it("returns null when neither source has a token", () => {
    expect(extractAccessToken(req({}))).toBeNull();
  });

  it("ignores empty cookie", () => {
    expect(
      extractAccessToken(req({ cookies: { [ACCESS_COOKIE_NAME]: "" } }))
    ).toBeNull();
  });

  it("ignores empty Bearer", () => {
    expect(extractAccessToken(req({ authorization: "Bearer " }))).toBeNull();
    expect(extractAccessToken(req({ authorization: "Bearer    " }))).toBeNull();
  });
});
