import { beforeEach, describe, expect, it } from "vitest";

import {
  EmailVerificationService,
  type IEmailVerificationRepository,
  type VerifyTokenRow,
} from "./email-verification.service.js";
import type { IAuthRepository, UserRow } from "./auth.repository.js";

/**
 * B4 — email verification service contract.
 *
 *   - issueToken(user) → creates a single-use row, returns plaintext token
 *   - confirm(token) → marks user.emailVerifiedAt = now, consumes token
 *   - Tokens are SHA-256 hashed at rest (DB only sees the hash)
 *   - Expired / consumed / unknown tokens → ForbiddenError / NotFoundError
 *   - Re-issuing for a verified user → idempotent: returns existing
 *     verifiedAt without minting new token
 */

interface FakeUserRow extends UserRow {}

class FakeUserRepo {
  users: FakeUserRow[] = [];
  async findUserById(id: string): Promise<FakeUserRow | null> {
    return this.users.find((u) => u.id === id) ?? null;
  }
  async findUserByEmail(email: string): Promise<FakeUserRow | null> {
    return this.users.find((u) => u.email?.toLowerCase() === email.toLowerCase()) ?? null;
  }
  async markEmailVerified(userId: string, at: Date): Promise<FakeUserRow> {
    const u = this.users.find((x) => x.id === userId);
    if (!u) throw new Error("not found");
    u.emailVerifiedAt = at;
    return u;
  }
  // Stub: unused in these tests.
  createUser = async () => {
    throw new Error("not used");
  };
  createSession = async () => {
    throw new Error("not used");
  };
  touchUserLastLogin = async () => {
    throw new Error("not used");
  };
  findActiveSessionByHash = async () => null;
  revokeSession = async () => undefined;
}

class FakeVerifyRepo implements IEmailVerificationRepository {
  tokens: VerifyTokenRow[] = [];

  async insert(input: Omit<VerifyTokenRow, "id" | "createdAt" | "consumedAt">): Promise<VerifyTokenRow> {
    const row: VerifyTokenRow = {
      id: `t-${this.tokens.length + 1}`,
      consumedAt: null,
      createdAt: new Date(),
      ...input,
    };
    this.tokens.push(row);
    return row;
  }

  async findByHash(hash: string): Promise<VerifyTokenRow | null> {
    return this.tokens.find((t) => t.tokenHash === hash) ?? null;
  }

  async consume(id: string, at: Date): Promise<void> {
    const t = this.tokens.find((x) => x.id === id);
    if (t) t.consumedAt = at;
  }

  async revokeAllForUser(userId: string, at: Date): Promise<number> {
    let n = 0;
    for (const t of this.tokens) {
      if (t.userId === userId && t.consumedAt == null) {
        t.consumedAt = at;
        n++;
      }
    }
    return n;
  }
}

function mkUser(overrides: Partial<FakeUserRow> = {}): FakeUserRow {
  return {
    id: "u1",
    email: "alice@example.com",
    name: "Alice",
    firstName: null,
    lastName: null,
    passwordHash: "hash",
    role: "user",
    status: "active",
    emailVerifiedAt: null,
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as FakeUserRow;
}

function makeService(): {
  svc: EmailVerificationService;
  users: FakeUserRepo;
  tokens: FakeVerifyRepo;
} {
  const users = new FakeUserRepo();
  const tokens = new FakeVerifyRepo();
  const svc = new EmailVerificationService(
    tokens,
    users as unknown as IAuthRepository,
    {
      ttlHours: 24,
      verifyBaseUrl: "https://capflow.example/verify-email",
    }
  );
  return { svc, users, tokens };
}

describe("EmailVerificationService — issueToken", () => {
  it("issues a token for an unverified user and returns plaintext URL", async () => {
    const { svc, users, tokens } = makeService();
    users.users.push(mkUser());

    const r = await svc.issueToken("u1");

    expect(r.alreadyVerified).toBe(false);
    expect(r.url).toMatch(/^https:\/\/capflow\.example\/verify-email\/[a-zA-Z0-9_-]+$/);
    expect(tokens.tokens).toHaveLength(1);
    // Token in DB is hashed, not plaintext.
    expect(tokens.tokens[0]!.tokenHash).not.toBe(r.url.split("/").pop());
    expect(tokens.tokens[0]!.userId).toBe("u1");
    expect(tokens.tokens[0]!.emailAtIssue).toBe("alice@example.com");
  });

  it("idempotently returns alreadyVerified=true and skips token mint when user already verified", async () => {
    const { svc, users, tokens } = makeService();
    users.users.push(mkUser({ emailVerifiedAt: new Date() }));

    const r = await svc.issueToken("u1");

    expect(r.alreadyVerified).toBe(true);
    expect(r.url).toBeNull();
    expect(tokens.tokens).toHaveLength(0);
  });

  it("revokes prior outstanding tokens for the same user on re-issue", async () => {
    const { svc, users, tokens } = makeService();
    users.users.push(mkUser());

    await svc.issueToken("u1");
    await svc.issueToken("u1");

    expect(tokens.tokens).toHaveLength(2);
    // First token is consumed (revoked) by the second issue; second remains live.
    expect(tokens.tokens[0]!.consumedAt).toBeInstanceOf(Date);
    expect(tokens.tokens[1]!.consumedAt).toBeNull();
  });

  it("rejects unknown userId", async () => {
    const { svc } = makeService();
    await expect(svc.issueToken("missing")).rejects.toThrow();
  });
});

describe("EmailVerificationService — confirm", () => {
  it("verifies user on a fresh valid token", async () => {
    const { svc, users, tokens } = makeService();
    users.users.push(mkUser());
    const issued = await svc.issueToken("u1");
    const rawToken = issued.url!.split("/").pop()!;

    const r = await svc.confirm(rawToken);

    expect(r.userId).toBe("u1");
    expect(users.users[0]!.emailVerifiedAt).toBeInstanceOf(Date);
    expect(tokens.tokens[0]!.consumedAt).toBeInstanceOf(Date);
  });

  it("rejects unknown token", async () => {
    const { svc } = makeService();
    await expect(svc.confirm("garbage")).rejects.toThrow(/not found|invalid/i);
  });

  it("rejects already-consumed token (replay protection)", async () => {
    const { svc, users } = makeService();
    users.users.push(mkUser());
    const issued = await svc.issueToken("u1");
    const rawToken = issued.url!.split("/").pop()!;

    await svc.confirm(rawToken);
    await expect(svc.confirm(rawToken)).rejects.toThrow();
  });

  it("rejects expired token", async () => {
    const { svc, users, tokens } = makeService();
    users.users.push(mkUser());
    const issued = await svc.issueToken("u1");
    const rawToken = issued.url!.split("/").pop()!;
    // Force-expire.
    tokens.tokens[0]!.expiresAt = new Date(Date.now() - 60_000);

    await expect(svc.confirm(rawToken)).rejects.toThrow(/expired/i);
  });

  it("ignores subsequent confirm if user was already verified", async () => {
    // Use case: admin manually marked user verified, then user clicks
    // the email link. Should NOT throw; just no-op and consume the token.
    const { svc, users } = makeService();
    users.users.push(mkUser());
    const issued = await svc.issueToken("u1");
    const rawToken = issued.url!.split("/").pop()!;

    // Manually set verifiedAt to "now-ish".
    const earlier = new Date(Date.now() - 60_000);
    users.users[0]!.emailVerifiedAt = earlier;

    const r = await svc.confirm(rawToken);
    expect(r.userId).toBe("u1");
    // Don't overwrite an earlier verification timestamp.
    expect(users.users[0]!.emailVerifiedAt!.getTime()).toBe(earlier.getTime());
  });
});
