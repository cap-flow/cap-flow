/**
 * B5 acceptance — wallet-aware comparison of the STORED shadow vs golden anchors.
 * Reads the latest ucb_shadow_results row (no re-run, no DeBank) and matches
 * positions per-wallet (GMX/Fluid receipts are shared across artur & murat).
 *
 * Run: cd apps/api && npx tsx --env-file=../../.env scripts/ucb-shadow-verify.mts
 */
import { readFileSync } from "node:fs";

import { createDbClient } from "@cap-flow/db";

import { WalletsRepository } from "../src/modules/wallets/wallets.repository.js";
import { UcbShadowRepository } from "../src/modules/ucb/ucb-shadow.repository.js";

const ACCOUNT_ID = "d96e847e-f030-47e5-82d6-8b0d5b2cf01f";
const GOLDEN =
  "/Users/vladimir/Desktop/cap-flow (для блокчейна)/.claude/worktrees/condescending-fermi-99f0ac/apps/web/src/lib/portfolio/__fixtures__/golden";

const dbClient = createDbClient({
  connectionString: process.env.DATABASE_URL ?? "",
  max: 2,
  idleTimeoutMillis: 10_000,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function matchPos(positions: any[], walletId: string, a: any) {
  return positions.find((p) => {
    if (p.walletId !== walletId) return false;
    if (p.chain !== a.anchor.chain || p.protocol.id !== a.anchor.protocolId) return false;
    if (a.anchor.tokenId) return p.matchedV3TokenId === a.anchor.tokenId;
    if (p.lpTokenId !== a.anchor.marketKey) return false;
    if (a.anchor.supplySymbol) return p.supplyTokens[0]?.symbol === a.anchor.supplySymbol;
    return true;
  });
}

async function main() {
  const walletsRepo = new WalletsRepository(dbClient.db);
  const shadowRepo = new UcbShadowRepository(dbClient.db);

  const nameToId = new Map<string, string>();
  for (const w of await walletsRepo.listByAccount(ACCOUNT_ID)) nameToId.set(w.name, w.id);
  console.log("[verify] wallets:", [...nameToId.entries()].map(([n, i]) => `${n}=${i.slice(0, 8)}`).join(", "));

  const latest = await shadowRepo.findLatestForAccount(ACCOUNT_ID);
  if (!latest) { console.log("[verify] no shadow row"); await dbClient.close(); return; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const positions = latest.positions as any[];
  console.log(`[verify] shadow row ${latest.id.slice(0, 8)} — ${positions.length} positions (engine ${latest.engineVersion})\n`);

  const anchors: any[] = [];
  for (const f of ["artur-1.json", "murat-1.json"]) {
    const fx = JSON.parse(readFileSync(`${GOLDEN}/${f}`, "utf8"));
    for (const a of fx.anchors ?? []) anchors.push(a);
  }

  let match = 0, diverge = 0, missing = 0;
  const notes: string[] = [];
  for (const a of anchors) {
    const wallet = a.label.split(":")[0];
    const walletId = nameToId.get(wallet);
    const isV3 = !!a.anchor.tokenId;
    const p = walletId ? matchPos(positions, walletId, a) : undefined;
    if (!p) {
      const why = isV3 ? " (V3 enrichment = B3, deferred → no matchedV3TokenId server-side)" : "";
      console.log(`  MISSING  ${a.label} exp $${Math.round(a.expected.startUsd)}${why}`);
      missing++;
      continue;
    }
    const exp = a.expected.startUsd, got = p.startUsd;
    const pct = exp ? Math.abs(got - exp) / Math.abs(exp) : 0;
    const tol = Math.max(a.expected.toleranceAbsUsd ?? 1, exp * (a.expected.tolerancePct ?? 0.005));
    const ok = Math.abs(got - exp) <= tol;
    console.log(`  ${ok ? "MATCH  " : "DIVERGE"} ${a.label}: server $${Math.round(got * 100) / 100} vs client $${Math.round(exp * 100) / 100} (${(pct * 100).toFixed(1)}%)`);
    if (ok) match++; else { diverge++; if (isV3) notes.push(`${a.label}: V3 override (B3) not ported`); }
  }
  console.log(`\n[verify] SUMMARY: ${match} match, ${diverge} diverge, ${missing} missing of ${anchors.length}.`);
  if (notes.length) console.log("[verify] expected gaps:", notes.join("; "));
  await dbClient.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
