/**
 * One-off: seed golden_cases for aida's 2 positions (audit 2026-06-08,
 * registry + on-chain verified). Run:
 *   cd apps/api && npx tsx --env-file=../../.env scripts/seed-aida-golden.mts
 * Idempotent: pre-delete by positionKey then insert (partial position_key index
 * breaks ON CONFLICT on this dev DB where migration 0032 isn't applied).
 *
 * POS-001 Fluid ETH: cost basis = USDC actually paid in swap 0x91c5dcb9
 *   (on-chain: 718.824102 USDC → 0.304514 WETH → ETH), NOT receive-side spot
 *   $513.50. Bug fixed in a93439a (token→token swap inherits consumed lot cost).
 * POS-002 GMX V2: cost basis = USDC paid to GMX deposit ($196.75 via linker),
 *   NOT GM receipt-spot $174.15.
 */
import { createDbClient, schema } from "@cap-flow/db";
import { eq } from "drizzle-orm";

const db = createDbClient({ connectionString: process.env.DATABASE_URL ?? "", max: 2 });

// aida "aida trust" wallet (оба позиции здесь).
const W = "bafcb962-c78d-4ff5-a7b3-5ba921a27bae";

// [posId, chain, protocolId, marketKey, label, startUsd, tolPct, note]
const ROWS: [string, string, string, string, string, number, number, string][] = [
  [
    "POS-001", "arb", "arb_fluid", "0x324c5dc1fc42c7a4d43d92df1eba58a54d13bf2d",
    "aida:Fluid:ETH", 718.82, 0.005,
    "ETH-залог в Fluid; cost = реально уплаченный USDC в swap 0x91c5dcb9 (on-chain 718.82 USDC → 0.304514 WETH→ETH), НЕ receive-side спот $513.50. Скрывал −28% убыток. Fix a93439a.",
  ],
  [
    "POS-002", "arb", "arb_gmx2", "0x70d95587d40a2caf56bd97485ab3eec10bee6336",
    "aida:GMX:GM-WETH-USDC", 196.67, 0.005,
    "GMX async-deposit: cost = уплаченный USDC $196.75 (linker), НЕ GM receipt-спот $174.15. PnL −11.4% = реальная стоимость входа GMX.",
  ],
];

async function main() {
  const admin = await db.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.role, "admin"))
    .limit(1);
  const createdBy = admin[0]?.id ?? null;
  let ok = 0;
  for (const [posId, chain, proto, market, label, startUsd, tolPct, note] of ROWS) {
    const key = `aida-2026-06-08:${posId}`;
    await db.db.delete(schema.goldenCases).where(eq(schema.goldenCases.positionKey, key));
    await db.db.insert(schema.goldenCases).values({
      walletId: W,
      positionId: posId,
      positionKey: key,
      chain,
      protocolId: proto,
      marketKey: market,
      openHash: null,
      label,
      kind: "golden",
      issue: null,
      expectedStartUsd: String(startUsd),
      expectedNetStartUsd: null,
      expectedPnlUsd: null,
      toleranceAbsUsd: "1",
      tolerancePct: String(tolPct),
      sourceOfTruth: "registry+onchain",
      provenanceNote: note,
      methodologyVersion: "ucb@a93439a",
      fixturePath: null,
      derivation: null,
      createdByUserId: createdBy,
      promotedFromAnomalyId: null,
    });
    ok++;
    console.log(`  ✓ ${posId} ${label} $${startUsd}`);
  }
  console.log(`\n[seed] ${ok}/${ROWS.length} golden cases upserted.`);
  await db.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
