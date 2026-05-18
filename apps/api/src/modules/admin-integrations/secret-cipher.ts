import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/**
 * AES-256-GCM at-rest encryption for upstream-integration secrets (B5).
 *
 * Why AES-GCM:
 *   - authenticated encryption — tampering with ciphertext or auth tag
 *     yields a decrypt error (no silent corruption / oracle attacks)
 *   - widely audited, Node-native (`node:crypto`), no third-party deps
 *
 * Format (single text column): `enc:v1:<iv_b64>:<tag_b64>:<ct_b64>` where
 * each part is base64url-encoded. The "enc:v1:" prefix lets future
 * versions co-exist and lets `isEncrypted()` cheaply discriminate
 * legacy plaintext rows from already-encrypted ones.
 *
 * The key is derived once at app start from `INTEGRATION_SECRETS_KEY`
 * if set, otherwise from `COOKIE_SECRET` via SHA-256 (HKDF-lite). Both
 * envs are already required ≥32 chars, so the derived 32-byte key has
 * full entropy.
 */

const PREFIX = "enc:v1:";
const IV_LEN = 12; // 96-bit, standard for GCM
const KEY_LEN = 32; // AES-256

function b64u(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromB64u(s: string): Buffer {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, "base64");
}

/**
 * Derive a 32-byte AES key from an arbitrary seed string. Uses SHA-256 as
 * a one-shot KDF — adequate when the seed itself has high entropy
 * (`COOKIE_SECRET` is enforced ≥32 chars at env-validation time).
 */
export function deriveKey(seed: string): Buffer {
  if (typeof seed !== "string" || seed.length < 32) {
    throw new RangeError(
      "deriveKey: seed must be a string of at least 32 chars"
    );
  }
  return createHash("sha256").update(seed, "utf8").digest();
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  if (key.length !== KEY_LEN) {
    throw new RangeError(`encryptSecret: key must be ${KEY_LEN} bytes`);
  }
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${b64u(iv)}:${b64u(tag)}:${b64u(ct)}`;
}

export function decryptSecret(payload: string, key: Buffer): string {
  if (typeof payload !== "string" || !payload.startsWith("enc:")) {
    throw new Error(
      "decryptSecret: payload missing 'enc:' prefix (wrong format?)"
    );
  }
  const parts = payload.split(":");
  if (parts.length !== 5) {
    throw new Error(
      `decryptSecret: malformed payload, expected 5 parts got ${parts.length}`
    );
  }
  if (parts[1] !== "v1") {
    throw new Error(
      `decryptSecret: unsupported version '${parts[1]}', expected v1`
    );
  }
  if (key.length !== KEY_LEN) {
    throw new RangeError(`decryptSecret: key must be ${KEY_LEN} bytes`);
  }
  const iv = fromB64u(parts[2]!);
  const tag = fromB64u(parts[3]!);
  const ct = fromB64u(parts[4]!);
  if (iv.length !== IV_LEN) {
    throw new Error(`decryptSecret: bad IV length ${iv.length}`);
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  // `final()` throws if auth tag check fails — propagate so callers
  // route tampered rows to a fail-closed path.
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

export function isEncrypted(s: string | null | undefined): boolean {
  if (typeof s !== "string" || !s.startsWith(PREFIX)) return false;
  const parts = s.split(":");
  // Strictly check version + part count so an arbitrary string starting
  // with "enc:" doesn't pass through as "encrypted".
  return parts.length === 5 && parts[1] === "v1";
}
