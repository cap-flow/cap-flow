/**
 * Local server-UCB test harness — compute the canonical positions for ANY wallet
 * the way the worker does (full enrichment: CEX + Krystal + non-Krystal V3 +
 * non-LP opener), warm the op-price cache first, store to ucb_shadow_results, and
 * print a readable positions table to eyeball against the client UI.
 *
 * Run:
 *   cd apps/api
 *   npx tsx --env-file=../../.env scripts/ucb-compute.mts <accountId | email> [--lifo|--wac|--fifo]
 */
import { createDbClient } from "@cap-flow/db";

import { AccountsRepository } from "../src/modules/accounts/accounts.repository.js";
import { AuthRepository } from "../src/modules/auth/auth.repository.js";
import { buildUcbRunnerStackFromDb } from "../src/modules/ucb/ucb-runner.factory.js";
import type { LotMethodology } from "@cap-flow/ucb/lots/types";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: ucb-compute.mts <accountId | email> [--lifo|--wac|--fifo]");
  process.exit(1);
}
const flag = process.argv.find((a) => a.startsWith("--"));
const methodology: LotMethodology =
  flag === "--lifo" ? "LIFO" : flag === "--wac" ? "WAC" : flag === "--hifo" ? "HIFO" : "FIFO";

const dbClient = createDbClient({
  connectionString: process.env.DATABASE_URL ?? "",
  max: 4,
  idleTimeoutMillis: 10_000,
});
const accountsRepo = new AccountsRepository(dbClient.db);
const authRepo = new AuthRepository(dbClient.db);

const env = {
  DEBANK_API_KEY: process.env.DEBANK_API_KEY,
  HELIUS_API_KEY: process.env.HELIUS_API_KEY,
  ETHERSCAN_API_KEY: process.env.ETHERSCAN_API_KEY,
  ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY,
  KRYSTAL_API_KEY: process.env.KRYSTAL_API_KEY,
};
const stack = buildUcbRunnerStackFromDb(dbClient.db, env, {
  flags: { enabled: async () => true },
  engineVersion: "local-compute",
  lotMethodology: methodology,
});

async function resolveAccountIds(): Promise<{ id: string; label: string }[]> {
  if (/^[0-9a-f-]{36}$/i.test(arg!)) {
    const a = await accountsRepo.findById(arg!);
    return a ? [{ id: a.id, label: `account ${a.id.slice(0, 8)}` }] : [];
  }
  const user = await authRepo.findUserByEmail(arg!);
  if (!user) return [];
  const accs = await accountsRepo.findActiveByOwner(user.id);
  return accs.map((a) => ({ id: a.id, label: `${arg} / account ${a.id.slice(0, 8)}` }));
}

async function warmPriceCache(accountId: string): Promise<void> {
  const wallets = await stack.opsRepo.loadComputeWalletsForAccount(accountId);
  const ops = wallets.flatMap((w) => w.ops);
  const { missing } = await stack.opPricingService.priceMapForOps(ops);
  if (missing.length > 0) {
    const filled = await stack.opPricingService.fillMissing(missing);
    console.log(`  [price cache] ${ops.length} ops, ${missing.length} missing → ${filled.written} filled`);
  } else {
    console.log(`  [price cache] ${ops.length} ops, cache warm (0 missing)`);
  }
}

function fmt(n: number | null | undefined): string {
  return n == null ? "—" : `$${(Math.round(n * 100) / 100).toLocaleString("en-US")}`;
}

async function main() {
  const accounts = await resolveAccountIds();
  if (accounts.length === 0) {
    console.error(`No account/user found for "${arg}".`);
    await dbClient.close();
    process.exit(1);
  }
  console.log(`[ucb-compute] methodology=${methodology}, ${accounts.length} account(s)\n`);

  for (const { id, label } of accounts) {
    console.log(`━━ ${label} ━━`);
    await warmPriceCache(id);
    const res = await stack.runner.run(id, "manual");
    if (res.error) {
      console.log(`  ⚠ compute error: ${res.error}\n`);
      continue;
    }
    const latest = await stack.shadowRepo.findLatestForAccount(id);
    if (!latest) {
      console.log(`  no positions stored (no EVM wallets / no live data?)\n`);
      continue;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const positions = latest.positions as any[];
    console.log(`  ${positions.length} positions:\n`);
    console.log(
      "  " +
        ["#", "protocol", "chain", "symbol", "v3", "startUsd", "currentUsd", "PnL", "fees", "flags"]
          .map((h, i) => h.padEnd([4, 16, 6, 8, 9, 12, 12, 11, 9, 6][i]))
          .join(""),
    );
    positions.forEach((p, i) => {
      const sym = p.supplyTokens?.map((t: any) => t.symbol).join("+") ?? "";
      const cols = [
        String(i + 1).padEnd(4),
        String(p.protocol?.id ?? p.protocol?.name ?? "").slice(0, 15).padEnd(16),
        String(p.chain ?? "").padEnd(6),
        sym.slice(0, 7).padEnd(8),
        String(p.matchedV3TokenId ?? "-").slice(0, 8).padEnd(9),
        fmt(p.startUsd).padEnd(12),
        fmt(p.currentUsd).padEnd(12),
        fmt(p.netPnlUsd).padEnd(11),
        fmt(p.feesUsd).padEnd(9),
        (p.coverageIncomplete ? "⚠inc" : "").padEnd(6),
      ];
      console.log("  " + cols.join(""));
    });
    console.log("");

    // Конвейер: per-stage статусы (pipeline-trace.ts → ucb_shadow_results.stages)
    const stages = (latest as unknown as { stages?: { stage: string; status: string; ms: number; metrics?: Record<string, unknown>; warnings?: string[] }[] | null }).stages;
    if (stages && stages.length > 0) {
      console.log("  pipeline:");
      const icon: Record<string, string> = { ok: "✓", warn: "⚠", fail: "✗", skipped: "·" };
      for (const s of stages) {
        const m = s.metrics
          ? Object.entries(s.metrics)
              .filter(([k]) => k !== "deltas")
              .map(([k, v]) => `${k}=${v}`)
              .join(" ")
          : "";
        const w = s.warnings?.length ? `  ⚠ ${s.warnings.join(" | ")}` : "";
        console.log(
          `    ${icon[s.status] ?? "?"} ${s.stage.padEnd(18)} ${String(s.ms + "ms").padEnd(8)} ${m}${w}`,
        );
        const deltas = s.metrics?.["deltas"];
        if (typeof deltas === "string") {
          try {
            for (const d of JSON.parse(deltas) as string[]) console.log(`        Δ ${d}`);
          } catch { /* raw */ }
        }
      }
      console.log("");
    }
  }
  await dbClient.close();
}

main().catch((e) => {
  console.error("[ucb-compute] FAILED:", e);
  process.exit(1);
});
