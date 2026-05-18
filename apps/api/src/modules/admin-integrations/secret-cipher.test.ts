import { describe, expect, it } from "vitest";

import {
  decryptSecret,
  encryptSecret,
  isEncrypted,
  deriveKey,
} from "./secret-cipher.js";

/**
 * AES-256-GCM encryption for integration_secrets.value (B5).
 *
 * Contract:
 *   - encryptSecret(plaintext, key) → "enc:v1:<iv>:<tag>:<ct>" (base64url
 *     parts). Format is self-describing so future v2 can coexist.
 *   - decryptSecret(s, key) → original plaintext. Throws on:
 *       * unknown/missing prefix
 *       * wrong key (auth tag mismatch)
 *       * tampered ciphertext (auth tag mismatch)
 *       * malformed payload
 *   - isEncrypted(s) → cheap prefix check so callers can route legacy
 *     plaintext rows through a one-shot upgrade-on-read.
 *   - deriveKey(seed) → 32-byte Buffer; deterministic per seed so the
 *     same COOKIE_SECRET-derived key works across restarts.
 *
 * Random 12-byte IV per call (AES-GCM standard); two encrypts of the
 * same plaintext+key MUST produce different ciphertexts.
 */
describe("secret-cipher", () => {
  const key = deriveKey("a-stable-seed-of-at-least-32-chars-for-tests-aaaaa");

  it("round-trip: encrypt then decrypt returns original", () => {
    const plaintext = "TRON-PRO-API-KEY-xyz-abc-1234567890";
    const ct = encryptSecret(plaintext, key);
    expect(decryptSecret(ct, key)).toBe(plaintext);
  });

  it("ciphertext has 'enc:v1:' prefix", () => {
    const ct = encryptSecret("hello", key);
    expect(ct.startsWith("enc:v1:")).toBe(true);
    expect(isEncrypted(ct)).toBe(true);
  });

  it("encrypts a unicode payload byte-perfectly", () => {
    const plaintext = "ключ-🔑-secret-żółć";
    expect(decryptSecret(encryptSecret(plaintext, key), key)).toBe(plaintext);
  });

  it("two encrypts of same plaintext produce different ciphertexts (random IV)", () => {
    const a = encryptSecret("same", key);
    const b = encryptSecret("same", key);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, key)).toBe(decryptSecret(b, key));
  });

  it("decrypt with wrong key throws", () => {
    const ct = encryptSecret("secret", key);
    const wrong = deriveKey("a-different-seed-of-at-least-32-chars-bbbbb-cccc");
    expect(() => decryptSecret(ct, wrong)).toThrow();
  });

  it("tampered ciphertext throws (auth tag rejects)", () => {
    const ct = encryptSecret("secret", key);
    const parts = ct.split(":");
    // Flip a bit in the ciphertext segment (last part).
    const tampered = ct.slice(0, -3) + "AAA";
    expect(tampered).not.toBe(ct);
    expect(parts).toHaveLength(5);
    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it("isEncrypted returns false for plaintext / empty / null-like", () => {
    expect(isEncrypted("some-plaintext-key")).toBe(false);
    expect(isEncrypted("")).toBe(false);
    expect(isEncrypted("enc:")).toBe(false);
    expect(isEncrypted("enc:v9:foo:bar:baz")).toBe(false); // unsupported version
  });

  it("decrypt rejects unknown / missing prefix with clear error", () => {
    expect(() => decryptSecret("plaintext-not-encrypted", key)).toThrow(
      /prefix|format/i
    );
    expect(() => decryptSecret("enc:v9:a:b:c", key)).toThrow(/version/i);
  });

  it("deriveKey is deterministic for the same seed", () => {
    const k1 = deriveKey("seed-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1234");
    const k2 = deriveKey("seed-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1234");
    expect(k1.equals(k2)).toBe(true);
  });

  it("deriveKey rejects short seeds", () => {
    expect(() => deriveKey("too-short")).toThrow();
  });

  it("deriveKey returns a 32-byte Buffer", () => {
    const k = deriveKey("any-long-enough-seed-for-derivation-32-chars-min");
    expect(k.length).toBe(32);
  });
});
