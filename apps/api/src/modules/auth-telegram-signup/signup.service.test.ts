import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { UserRow } from "../auth/auth.repository.js";

import type {
  ITelegramSignupRepository,
  TelegramSignupNonceRow,
} from "./signup.repository.js";
import {
  parseSignupStartCode,
  SignupNonceError,
  TelegramSignupService,
} from "./signup.service.js";

const stubLog = {
  warn: () => {},
  error: () => {},
  info: () => {},
} as never;

const stubAudit = { log: async () => {} } as never;

// ─── In-memory fake repo для unit-тестов ────────────────────────────

class FakeRepo implements ITelegramSignupRepository {
  nonces = new Map<string, TelegramSignupNonceRow>();
  users = new Map<string, UserRow>();
  usersByTelegramId = new Map<number, UserRow>();
  nextUserId = 1;
  usernameTaken = new Set<string>();
  defaultsByUserId = new Map<string, { hasAccount: boolean; hasLink: boolean }>();

  async ensureUserDefaults(input: {
    userId: string;
    telegramChatId: number;
    telegramUsername: string | null;
  }): Promise<void> {
    void input.telegramChatId;
    void input.telegramUsername;
    this.defaultsByUserId.set(input.userId, {
      hasAccount: true,
      hasLink: true,
    });
  }

  async createNonce(input: {
    nonceHash: string;
    expiresAt: Date;
  }): Promise<void> {
    this.nonces.set(input.nonceHash, {
      nonceHash: input.nonceHash,
      userId: null,
      telegramUserId: null,
      telegramChatId: null,
      telegramUsername: null,
      createdAt: new Date(),
      expiresAt: input.expiresAt,
      consumedAt: null,
    });
  }

  async findNonce(
    nonceHash: string,
  ): Promise<TelegramSignupNonceRow | null> {
    return this.nonces.get(nonceHash) ?? null;
  }

  async bindNonceToUser(input: {
    nonceHash: string;
    userId: string;
    telegramUserId: number;
    telegramChatId: number;
    telegramUsername: string | null;
  }): Promise<void> {
    const row = this.nonces.get(input.nonceHash);
    if (!row) return;
    row.userId = input.userId;
    row.telegramUserId = input.telegramUserId;
    row.telegramChatId = input.telegramChatId;
    row.telegramUsername = input.telegramUsername;
  }

  async consumeNonce(
    nonceHash: string,
  ): Promise<TelegramSignupNonceRow | null> {
    const row = this.nonces.get(nonceHash);
    if (!row) return null;
    if (row.consumedAt) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    if (!row.userId) return null;
    row.consumedAt = new Date();
    return row;
  }

  async findUserByTelegramId(id: number): Promise<UserRow | null> {
    return this.usersByTelegramId.get(id) ?? null;
  }

  async findUserAnyStatusById(id: string): Promise<UserRow | null> {
    return this.users.get(id) ?? null;
  }

  async createTelegramUser(input: {
    telegramUserId: number;
    telegramUsername: string | null;
    firstName: string | null;
    lastName: string | null;
    telegramChatId: number;
  }): Promise<UserRow> {
    void input.telegramChatId;
    const id = `u${this.nextUserId++}`;
    const user: UserRow = {
      id,
      legacyId: null,
      telegramId: input.telegramUserId,
      telegramUsername: input.telegramUsername,
      firstName: input.firstName,
      lastName: input.lastName,
      email: null,
      passwordHash: null,
      name: null,
      emailVerifiedAt: null,
      lastLoginAt: null,
      username: null,
      role: "user",
      status: "pending",
      notes: null,
      activeAccountId: null,
      trackedTickers: [],
      billingMeta: null,
      lotMethodology: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.users.set(id, user);
    this.usersByTelegramId.set(input.telegramUserId, user);
    return user;
  }

  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    const u = this.users.get(userId);
    if (!u) throw new Error("not found");
    this.users.set(userId, { ...u, passwordHash });
  }

  async setInitialPasswordAndUsername(
    userId: string,
    passwordHash: string,
    username: string | null,
  ): Promise<void> {
    if (username && this.usernameTaken.has(username)) {
      throw new Error(
        `duplicate key value violates unique constraint "users_username_uq"`,
      );
    }
    const u = this.users.get(userId);
    if (!u) throw new Error("not found");
    if (username) this.usernameTaken.add(username);
    this.users.set(userId, {
      ...u,
      passwordHash,
      username,
      status: "active",
    });
  }
}

const cfg = { siteOrigin: "https://cap-flow.ru", nonceTtlMinutes: 10 };
const getBotUsername = () => "defiCapflow_bot";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("parseSignupStartCode", () => {
  it("matches s_ prefix → returns raw nonce", () => {
    expect(parseSignupStartCode("s_abc123")).toBe("abc123");
  });
  it("non-signup codes return null (legacy link flow)", () => {
    expect(parseSignupStartCode("74d90a1ae31cd16b")).toBeNull();
    expect(parseSignupStartCode("link_xxx")).toBeNull();
  });
  it("empty payload after s_ returns null", () => {
    expect(parseSignupStartCode("s_")).toBeNull();
  });
});

describe("TelegramSignupService", () => {
  it("startSignup → creates nonce, returns deep-link", async () => {
    const repo = new FakeRepo();
    const s = new TelegramSignupService(
      repo,
      stubAudit,
      cfg,
      stubLog,
      getBotUsername,
    );
    const r = await s.startSignup();
    expect(r.botDeepLink).toBe(
      `https://t.me/defiCapflow_bot?start=s_${r.rawNonce}`,
    );
    expect(repo.nonces.size).toBe(1);
    expect(repo.nonces.get(sha256(r.rawNonce))).toBeDefined();
  });

  it("handleBotStart creates new user (по telegram_id) и связывает с nonce", async () => {
    const repo = new FakeRepo();
    const s = new TelegramSignupService(
      repo,
      stubAudit,
      cfg,
      stubLog,
      getBotUsername,
    );
    const { rawNonce } = await s.startSignup();
    const r = await s.handleBotStart({
      rawNonce,
      telegramUserId: 12345,
      telegramChatId: 12345,
      telegramUsername: "alice",
      firstName: "Alice",
      lastName: null,
    });
    expect(r.createdNewUser).toBe(true);
    expect(r.finishUrl).toBe(
      `https://cap-flow.ru/api/v1/auth/telegram/finish?nonce=${encodeURIComponent(rawNonce)}`,
    );
    const nonceRow = repo.nonces.get(sha256(rawNonce))!;
    expect(nonceRow.userId).toBeTruthy();
    expect(nonceRow.telegramUserId).toBe(12345);
    const user = repo.users.get(nonceRow.userId!)!;
    // Task #43: auto-provisioning переводит user в active + ставит password +
    // username (= telegramUsername "alice" если свободен).
    expect(user.status).toBe("active");
    expect(user.telegramId).toBe(12345);
    expect(user.telegramUsername).toBe("alice");
    expect(user.passwordHash).toBeTruthy();
    expect(r.initialCredentials).not.toBeNull();
    expect(r.initialCredentials?.username).toBe("alice");
    expect(r.initialCredentials?.password.length).toBeGreaterThan(8);
  });

  it("handleBotStart для returning user: createdNewUser=false, тот же user.id", async () => {
    const repo = new FakeRepo();
    const s = new TelegramSignupService(
      repo,
      stubAudit,
      cfg,
      stubLog,
      getBotUsername,
    );
    // Первая регистрация.
    const first = await s.startSignup();
    await s.handleBotStart({
      rawNonce: first.rawNonce,
      telegramUserId: 999,
      telegramChatId: 999,
      telegramUsername: "bob",
      firstName: "Bob",
      lastName: null,
    });
    const firstUserId = repo.usersByTelegramId.get(999)!.id;
    // Вторая попытка с тем же Telegram ID — должна найти существующего.
    const second = await s.startSignup();
    const r = await s.handleBotStart({
      rawNonce: second.rawNonce,
      telegramUserId: 999,
      telegramChatId: 999,
      telegramUsername: "bob",
      firstName: "Bob",
      lastName: null,
    });
    expect(r.createdNewUser).toBe(false);
    expect(repo.nonces.get(sha256(second.rawNonce))!.userId).toBe(firstUserId);
    // Только один user в БД.
    expect(repo.users.size).toBe(1);
  });

  it("handleBotStart на expired nonce → SignupNonceError(expired)", async () => {
    const repo = new FakeRepo();
    const s = new TelegramSignupService(
      repo,
      stubAudit,
      cfg,
      stubLog,
      getBotUsername,
    );
    // Создаём nonce и вручную делаем его просроченным.
    const { rawNonce } = await s.startSignup();
    const row = repo.nonces.get(sha256(rawNonce))!;
    row.expiresAt = new Date(Date.now() - 1000);
    await expect(
      s.handleBotStart({
        rawNonce,
        telegramUserId: 1,
        telegramChatId: 1,
        telegramUsername: null,
        firstName: null,
        lastName: null,
      }),
    ).rejects.toBeInstanceOf(SignupNonceError);
  });

  it("handleBotStart на не существующий nonce → not_found", async () => {
    const repo = new FakeRepo();
    const s = new TelegramSignupService(
      repo,
      stubAudit,
      cfg,
      stubLog,
      getBotUsername,
    );
    try {
      await s.handleBotStart({
        rawNonce: "nonexistent",
        telegramUserId: 1,
        telegramChatId: 1,
        telegramUsername: null,
        firstName: null,
        lastName: null,
      });
      expect.fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SignupNonceError);
      expect((e as SignupNonceError).reason).toBe("not_found");
    }
  });

  it("повторный handleBotStart с тем же rawNonce и тем же Telegram user — idempotent (no error, тот же finishUrl)", async () => {
    const repo = new FakeRepo();
    const s = new TelegramSignupService(
      repo,
      stubAudit,
      cfg,
      stubLog,
      getBotUsername,
    );
    const { rawNonce } = await s.startSignup();
    const r1 = await s.handleBotStart({
      rawNonce,
      telegramUserId: 42,
      telegramChatId: 42,
      telegramUsername: "x",
      firstName: null,
      lastName: null,
    });
    const r2 = await s.handleBotStart({
      rawNonce,
      telegramUserId: 42,
      telegramChatId: 42,
      telegramUsername: "x",
      firstName: null,
      lastName: null,
    });
    expect(r1.finishUrl).toBe(r2.finishUrl);
    expect(r2.createdNewUser).toBe(false);
  });

  it("handleBotStart того же nonce разными Telegram users → SignupNonceError(conflict)", async () => {
    const repo = new FakeRepo();
    const s = new TelegramSignupService(
      repo,
      stubAudit,
      cfg,
      stubLog,
      getBotUsername,
    );
    const { rawNonce } = await s.startSignup();
    await s.handleBotStart({
      rawNonce,
      telegramUserId: 1,
      telegramChatId: 1,
      telegramUsername: null,
      firstName: null,
      lastName: null,
    });
    await expect(
      s.handleBotStart({
        rawNonce,
        telegramUserId: 2,
        telegramChatId: 2,
        telegramUsername: null,
        firstName: null,
        lastName: null,
      }),
    ).rejects.toMatchObject({ reason: "conflict" });
  });

  it("finishLogin happy path → ok + needsPasswordSetup=false (auto-provisioned password)", async () => {
    const repo = new FakeRepo();
    const s = new TelegramSignupService(
      repo,
      stubAudit,
      cfg,
      stubLog,
      getBotUsername,
    );
    const { rawNonce } = await s.startSignup();
    // Task #43: auto-provisioning ставит password сразу → finish-login
    // больше не требует set-password.
    await s.handleBotStart({
      rawNonce,
      telegramUserId: 100,
      telegramChatId: 100,
      telegramUsername: "z",
      firstName: null,
      lastName: null,
    });
    const r = await s.finishLogin(rawNonce);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.user.telegramId).toBe(100);
      expect(r.needsPasswordSetup).toBe(false);
    }
  });

  it("finishLogin для returning user с password → needsPasswordSetup=false", async () => {
    const repo = new FakeRepo();
    const s = new TelegramSignupService(
      repo,
      stubAudit,
      cfg,
      stubLog,
      getBotUsername,
    );
    // Setup: создаём user'а, ставим пароль.
    const first = await s.startSignup();
    await s.handleBotStart({
      rawNonce: first.rawNonce,
      telegramUserId: 7,
      telegramChatId: 7,
      telegramUsername: null,
      firstName: null,
      lastName: null,
    });
    const ok1 = await s.finishLogin(first.rawNonce);
    if (ok1.kind !== "ok") expect.fail("first finish failed");
    await s.setInitialPassword(ok1.user.id, "hash_xxx", "myname");

    // Returning login: фреш nonce, тот же Telegram user, password
    // уже стоит → needsPasswordSetup=false.
    const second = await s.startSignup();
    await s.handleBotStart({
      rawNonce: second.rawNonce,
      telegramUserId: 7,
      telegramChatId: 7,
      telegramUsername: null,
      firstName: null,
      lastName: null,
    });
    const r = await s.finishLogin(second.rawNonce);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.needsPasswordSetup).toBe(false);
      expect(r.user.username).toBe("myname");
    }
  });

  it("finishLogin one-shot: повторный вызов после consume → gone", async () => {
    const repo = new FakeRepo();
    const s = new TelegramSignupService(
      repo,
      stubAudit,
      cfg,
      stubLog,
      getBotUsername,
    );
    const { rawNonce } = await s.startSignup();
    await s.handleBotStart({
      rawNonce,
      telegramUserId: 1,
      telegramChatId: 1,
      telegramUsername: null,
      firstName: null,
      lastName: null,
    });
    const r1 = await s.finishLogin(rawNonce);
    expect(r1.kind).toBe("ok");
    const r2 = await s.finishLogin(rawNonce);
    expect(r2.kind).toBe("gone");
  });

  it("finishLogin до bot binding → gone (без user_id)", async () => {
    const repo = new FakeRepo();
    const s = new TelegramSignupService(
      repo,
      stubAudit,
      cfg,
      stubLog,
      getBotUsername,
    );
    const { rawNonce } = await s.startSignup();
    // Бот ещё не пришёл — userId NULL → /finish даёт gone.
    const r = await s.finishLogin(rawNonce);
    expect(r.kind).toBe("gone");
  });

  it("handleBotStart провижит primary account + telegram_link через ensureUserDefaults", async () => {
    const repo = new FakeRepo();
    const s = new TelegramSignupService(
      repo,
      stubAudit,
      cfg,
      stubLog,
      getBotUsername,
    );
    const { rawNonce } = await s.startSignup();
    await s.handleBotStart({
      rawNonce,
      telegramUserId: 555,
      telegramChatId: 555,
      telegramUsername: "u555",
      firstName: null,
      lastName: null,
    });
    const userId = repo.usersByTelegramId.get(555)!.id;
    const defaults = repo.defaultsByUserId.get(userId);
    expect(defaults?.hasAccount).toBe(true);
    expect(defaults?.hasLink).toBe(true);
  });

  it("ensureUserDefaults вызывается и для returning users (backfill)", async () => {
    const repo = new FakeRepo();
    const s = new TelegramSignupService(
      repo,
      stubAudit,
      cfg,
      stubLog,
      getBotUsername,
    );
    // Первая регистрация.
    const first = await s.startSignup();
    await s.handleBotStart({
      rawNonce: first.rawNonce,
      telegramUserId: 600,
      telegramChatId: 600,
      telegramUsername: null,
      firstName: null,
      lastName: null,
    });
    // Симулируем что предыдущий signup не провижнул defaults (старая баг).
    const userId = repo.usersByTelegramId.get(600)!.id;
    repo.defaultsByUserId.delete(userId);

    // Returning login через fresh nonce.
    const second = await s.startSignup();
    await s.handleBotStart({
      rawNonce: second.rawNonce,
      telegramUserId: 600,
      telegramChatId: 600,
      telegramUsername: null,
      firstName: null,
      lastName: null,
    });
    const defaults = repo.defaultsByUserId.get(userId);
    expect(defaults?.hasAccount).toBe(true);
    expect(defaults?.hasLink).toBe(true);
  });
});
