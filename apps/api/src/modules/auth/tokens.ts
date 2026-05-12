import { createHash, randomBytes } from "node:crypto";

import jwt, { type SignOptions } from "jsonwebtoken";

import { UnauthorizedError } from "../../core/errors.js";

import type { UserRole } from "./auth.types.js";

export interface AccessTokenPayload {
  readonly sub: string;
  readonly role: UserRole;
  readonly sid: string;
}

export interface SignedAccessToken {
  readonly token: string;
  readonly expiresAt: Date;
}

export function signAccessToken(
  payload: AccessTokenPayload,
  secret: string,
  ttlMinutes: number
): SignedAccessToken {
  const expiresInSec = ttlMinutes * 60;
  const opts: SignOptions = { expiresIn: expiresInSec };
  const token = jwt.sign(payload, secret, opts);
  const expiresAt = new Date(Date.now() + expiresInSec * 1000);
  return { token, expiresAt };
}

export function verifyAccessToken(
  token: string,
  secret: string
): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, secret);
    if (typeof decoded !== "object" || decoded === null) {
      throw new UnauthorizedError("Invalid token payload.");
    }
    const { sub, role, sid } = decoded as Record<string, unknown>;
    if (
      typeof sub !== "string" ||
      (role !== "admin" && role !== "user" && role !== "viewer") ||
      typeof sid !== "string"
    ) {
      throw new UnauthorizedError("Invalid token payload.");
    }
    return { sub, role, sid };
  } catch (err) {
    if (err instanceof UnauthorizedError) throw err;
    throw new UnauthorizedError("Invalid or expired token.");
  }
}

/** Refresh tokens are random 32-byte secrets, stored hashed in DB. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString("hex");
}

/** Invite tokens follow the same pattern but are shorter. */
export function generateInviteToken(): string {
  return randomBytes(24).toString("hex");
}

/** SHA-256 — fast, deterministic, lookup-friendly. Not for passwords. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
