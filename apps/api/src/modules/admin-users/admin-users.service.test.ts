/**
 * Bug fix: 500 на admin Users page.
 *
 * Root cause: `db.execute<T>()` raw SQL возвращает timestamptz как STRING
 * (а не Date), потому что type parameter — это lишь TS hint, не runtime
 * parsing. Mapping в `listUsers` присваивал raw `r.created_at` напрямую в
 * `UserRow.createdAt`. Затем `toAdminUserResponse(u).createdAt.toISOString()`
 * крашился потому что string не имеет .toISOString() → 500 Internal Server.
 *
 * Fix: coerce все timestamp поля через `toDate(v)` helper.
 */
import { describe, expect, it } from "vitest";

import { AdminUsersService } from "./admin-users.service.js";

interface MockExecuteRow {
  id: string;
  email: string | null;
  password_hash: string | null;
  name: string | null;
  legacy_id: string | null;
  telegram_id: string | null;
  telegram_username: string | null;
  first_name: string | null;
  last_name: string | null;
  role: string;
  status: string;
  notes: string | null;
  active_account_id: string | null;
  tracked_tickers: string[] | null;
  billing_meta: unknown;
  email_verified_at: Date | string | null;
  last_login_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  account_count: number;
  last_snapshot_at: Date | string | null;
  last_snapshot_usd: string | null;
}

function makeMockDb(rows: MockExecuteRow[]) {
  return {
    async execute() {
      return { rows };
    },
  };
}

function baseRow(overrides: Partial<MockExecuteRow> = {}): MockExecuteRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    email: "test@example.com",
    password_hash: null,
    name: "Test",
    legacy_id: null,
    telegram_id: null,
    telegram_username: null,
    first_name: null,
    last_name: null,
    role: "user",
    status: "active",
    notes: null,
    active_account_id: null,
    tracked_tickers: [],
    billing_meta: null,
    email_verified_at: null,
    last_login_at: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    account_count: 0,
    last_snapshot_at: null,
    last_snapshot_usd: null,
    ...overrides,
  };
}

describe("AdminUsersService.listUsers — date coercion (500 bug fix)", () => {
  it("handles string timestamps from raw SQL execute", async () => {
    const db = makeMockDb([
      baseRow({
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
        last_login_at: "2026-01-03T00:00:00.000Z",
      }),
    ]);
    const svc = new AdminUsersService(
      db as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const page = await svc.listUsers();
    expect(page.items).toHaveLength(1);
    const entry = page.items[0]!;
    expect(entry.user.createdAt).toBeInstanceOf(Date);
    expect(entry.user.createdAt.toISOString()).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(entry.user.updatedAt).toBeInstanceOf(Date);
    expect(entry.user.lastLoginAt).toBeInstanceOf(Date);
  });

  it("handles Date timestamps from ORM (backward compat)", async () => {
    const db = makeMockDb([
      baseRow({
        created_at: new Date("2026-02-01T00:00:00Z"),
        last_login_at: new Date("2026-02-02T00:00:00Z"),
      }),
    ]);
    const svc = new AdminUsersService(
      db as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const page = await svc.listUsers();
    expect(page.items[0]?.user.createdAt.toISOString()).toBe(
      "2026-02-01T00:00:00.000Z",
    );
  });

  it("handles NULL timestamps gracefully", async () => {
    const db = makeMockDb([
      baseRow({
        last_login_at: null,
        email_verified_at: null,
      }),
    ]);
    const svc = new AdminUsersService(
      db as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const page = await svc.listUsers();
    expect(page.items[0]?.user.lastLoginAt).toBeNull();
    expect(page.items[0]?.user.emailVerifiedAt).toBeNull();
  });

  it("handles snapshot timestamps as string OR Date", async () => {
    const db = makeMockDb([
      baseRow({ last_snapshot_at: "2026-05-18T02:00:00.000Z" }),
    ]);
    const svc = new AdminUsersService(
      db as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const page = await svc.listUsers();
    expect(page.items[0]?.lastSnapshotAt).toBeInstanceOf(Date);
  });

  it("handles cursor as string (M14 pagination)", async () => {
    const db = makeMockDb([
      baseRow({ created_at: "2026-05-18T02:00:00.000Z" }),
    ]);
    const svc = new AdminUsersService(
      db as never,
      {} as never,
      {} as never,
      {} as never,
    );
    // With cursor = string timestamp, last item should provide valid nextCursor (none here, only 1 item < limit).
    const page = await svc.listUsers({ limit: 50 });
    expect(page.nextCursor).toBeNull();
  });
});
