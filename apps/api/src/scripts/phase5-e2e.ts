/**
 * Phase 5 E2E smoke-test: hits every new admin endpoint with an admin JWT
 * + a non-admin JWT and asserts the expected status codes. Idempotent —
 * uses login (no fixture creation), so it can run repeatedly against a dev
 * stack that already has the seed admin and at least one non-admin user.
 *
 * Запуск:
 *   set -a && . ./.env && set +a && \
 *     pnpm --filter @cap-flow/api exec tsx src/scripts/phase5-e2e.ts
 *
 * Optional env:
 *   E2E_API_URL    (default http://localhost:3000)
 *   ALICE_EMAIL    (default alice@example.com)  — must exist & be active
 *   ALICE_PASSWORD (default ChangeMe_Alice_2026)
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "vladimir@cap-flow.ru";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
const ALICE_EMAIL = process.env.ALICE_EMAIL ?? "alice@example.com";
const ALICE_PASSWORD = process.env.ALICE_PASSWORD ?? "ChangeMe_Alice_2026";

interface CaseResult {
  name: string;
  ok: boolean;
  detail: string;
}
const results: CaseResult[] = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  const tag = ok ? "✓" : "✗";
  console.log(`  ${tag} ${name} — ${detail}`);
}

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${API}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(
      `login(${email}) → ${res.status} ${await res.text().catch(() => "")}`
    );
  }
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

interface FetchOpts {
  readonly token?: string;
  readonly method?: string;
  readonly body?: unknown;
}

async function call(
  path: string,
  opts: FetchOpts = {}
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const init: RequestInit = { method: opts.method ?? "GET", headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await fetch(`${API}${path}`, init);
  let body: unknown = null;
  const text = await res.text();
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

async function main(): Promise<void> {
  if (!ADMIN_PASSWORD) {
    console.error("ADMIN_PASSWORD env not set (source .env first).");
    process.exit(1);
  }

  console.log(`Phase 5 E2E vs ${API}`);
  console.log("------------------------------------------------------------");

  // 1. preflight — admin login
  let adminToken = "";
  try {
    adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    record("0.admin login", true, "got access token");
  } catch (e) {
    record("0.admin login", false, String((e as Error).message));
    finalize();
    return;
  }

  // 2. preflight — non-admin login (optional; needed only for tenant
  //    isolation + alice setStatus round-trip). Not recorded as a failure
  //    when the password isn't known to the env — the smoke test still
  //    passes for the admin-only path.
  let aliceToken = "";
  try {
    aliceToken = await login(ALICE_EMAIL, ALICE_PASSWORD);
    console.log(`  ℹ alice login — got access token, will run iso cases`);
  } catch (e) {
    console.log(
      `  ℹ alice login skipped — ${String((e as Error).message).slice(0, 80)}`
    );
  }

  // ─── admin/portfolios ────────────────────────────────────────────────
  {
    const { status, body } = await call("/api/v1/admin/portfolios", {
      token: adminToken,
    });
    const arr = Array.isArray(body) ? body : null;
    record(
      "1.GET /admin/portfolios (admin)",
      status === 200 && arr !== null,
      `status=${status}, rows=${arr?.length ?? "?"}`
    );
  }
  {
    const { status } = await call("/api/v1/admin/portfolios/aggregate", {
      token: adminToken,
    });
    record(
      "2.GET /admin/portfolios/aggregate (admin)",
      status === 200,
      `status=${status}`
    );
  }
  if (aliceToken) {
    const { status } = await call("/api/v1/admin/portfolios", {
      token: aliceToken,
    });
    record(
      "3.GET /admin/portfolios (alice) → 403",
      status === 403,
      `status=${status}`
    );
  }

  // ─── admin/metrics ───────────────────────────────────────────────────
  {
    const { status, body } = await call("/api/v1/admin/metrics/saas", {
      token: adminToken,
    });
    const ok =
      status === 200 &&
      typeof body === "object" &&
      body !== null &&
      "users" in body &&
      "dau" in body;
    record(
      "4.GET /admin/metrics/saas (admin)",
      ok,
      `status=${status}, shape=${ok ? "ok" : JSON.stringify(body).slice(0, 80)}`
    );
  }

  // ─── admin/audit ─────────────────────────────────────────────────────
  {
    const { status, body } = await call(
      "/api/v1/admin/audit?limit=5&sinceHours=24",
      { token: adminToken }
    );
    const arr = Array.isArray(body) ? body : null;
    record(
      "5.GET /admin/audit (admin)",
      status === 200 && arr !== null,
      `status=${status}, entries=${arr?.length ?? "?"}`
    );
  }
  {
    const { status, body } = await call(
      "/api/v1/admin/audit/action-counts?hours=24",
      { token: adminToken }
    );
    const arr = Array.isArray(body) ? body : null;
    record(
      "6.GET /admin/audit/action-counts (admin)",
      status === 200 && arr !== null,
      `status=${status}, actions=${arr?.length ?? "?"}`
    );
  }

  // ─── admin/tech-audit ────────────────────────────────────────────────
  {
    const { status, body } = await call("/api/v1/admin/tech-audit", {
      token: adminToken,
    });
    const ok =
      status === 200 &&
      typeof body === "object" &&
      body !== null &&
      "findings" in body &&
      "summary" in body;
    record(
      "7.GET /admin/tech-audit (admin)",
      ok,
      `status=${status}, shape=${ok ? "ok" : JSON.stringify(body).slice(0, 80)}`
    );
  }

  // ─── admin/queue ────────────────────────────────────────────────────
  {
    const { status, body } = await call("/api/v1/admin/queue/status", {
      token: adminToken,
    });
    const ok =
      status === 200 &&
      typeof body === "object" &&
      body !== null &&
      "counts" in body &&
      "recurringSchedules" in body;
    record(
      "8.GET /admin/queue/status (admin)",
      ok,
      `status=${status}, shape=${ok ? "ok" : JSON.stringify(body).slice(0, 80)}`
    );
  }

  // ─── admin/queue/ui (bull-board) — requires auth, no JWT in headers → 401
  {
    const res = await fetch(`${API}/api/v1/admin/queue/ui/`);
    record(
      "9.GET /admin/queue/ui (no token) → 401",
      res.status === 401,
      `status=${res.status}`
    );
  }
  {
    const res = await fetch(`${API}/api/v1/admin/queue/ui/`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const text = await res.text();
    // Bull-board's entry HTML contains <title>Bull Dashboard</title> or
    // similar; we accept any 200 with HTML response.
    const ok = res.status === 200 && /<html|<!DOCTYPE/i.test(text);
    record(
      "10.GET /admin/queue/ui (admin) → 200 HTML",
      ok,
      `status=${res.status}, html=${ok}`
    );
  }
  if (aliceToken) {
    const res = await fetch(`${API}/api/v1/admin/queue/ui/`, {
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    record(
      "11.GET /admin/queue/ui (alice) → 403",
      res.status === 403,
      `status=${res.status}`
    );
  }

  // ─── admin/users mutation: setStatus round-trip on alice ────────────
  if (aliceToken) {
    // resolve alice id from /admin/users
    const list = await call(
      `/api/v1/admin/users?search=${encodeURIComponent(ALICE_EMAIL)}`,
      { token: adminToken }
    );
    const arr = Array.isArray(list.body) ? list.body : [];
    const alice = arr.find(
      (u: any) => typeof u?.email === "string" && u.email === ALICE_EMAIL
    ) as { id?: string; status?: string } | undefined;
    if (alice?.id) {
      // toggle blocked → active
      const block = await call(`/api/v1/admin/users/${alice.id}/status`, {
        token: adminToken,
        method: "PATCH",
        body: { status: "blocked" },
      });
      record(
        "12.PATCH /admin/users/:id/status → blocked",
        block.status === 200 &&
          (block.body as any)?.status === "blocked",
        `status=${block.status}`
      );
      // alice's old access token should now be rejected (sessions revoked)
      const meAfterBlock = await call("/api/v1/auth/me", {
        token: aliceToken,
      });
      record(
        "13.alice /auth/me after block → 401",
        meAfterBlock.status === 401,
        `status=${meAfterBlock.status}`
      );
      const restore = await call(`/api/v1/admin/users/${alice.id}/status`, {
        token: adminToken,
        method: "PATCH",
        body: { status: "active" },
      });
      record(
        "14.PATCH /admin/users/:id/status → active",
        restore.status === 200 &&
          (restore.body as any)?.status === "active",
        `status=${restore.status}`
      );
    } else {
      record(
        "12-14.alice setStatus round-trip",
        false,
        `couldn't resolve alice id from list`
      );
    }
  }

  finalize();
}

function finalize(): void {
  const passed = results.filter((r) => r.ok).length;
  console.log("------------------------------------------------------------");
  console.log(`${passed}/${results.length} cases passed`);
  if (passed !== results.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
