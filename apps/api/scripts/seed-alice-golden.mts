/**
 * One-off: seed golden_cases for Alice's 12 positions (registry-verified
 * 2026-06-04). Run: cd apps/api && npx tsx --env-file=../../.env scripts/seed-alice-golden.mts
 * Idempotent: createGolden upserts by active positionKey.
 */
import { createDbClient, schema } from "@cap-flow/db";
import { eq } from "drizzle-orm";

import { GoldenRepository } from "../src/modules/golden/golden.repository.js";

const db = createDbClient({ connectionString: process.env.DATABASE_URL ?? "", max: 2 });
const repo = new GoldenRepository(db.db);

const A1 = "eb975248-1afd-47f8-a682-898eae8c5b7a";
const A2 = "3c3fcee0-5267-4f5f-a905-3780c756fd76";
const A3 = "629c5748-93b8-4da6-a641-c39d0298981c";

// [posId, wallet, chain, protocolId, marketKey, openHash, label, startUsd, source, tolPct, note]
const ROWS: [string, string, string, string, string, string | null, string, number, string, number, string][] = [
  ["POS-001", A1, "hyper", "hyper_morphoblue", "0x242572d6f1af7111bca807ecdd0f74108ceaed5d", "0xd5f57153a359173ccca66eb982759398691f190dc31f611040ed1676510a072f", "alice:Morpho:USD₮0", 126.03, "manual", 0.005, "supply USD₮0 126.03 (bridged) × $1"],
  ["POS-002", A1, "eth", "morphoblue", "0x3365554a61ceff74a76528f9e86c1e87946d16a5", "0x0605ea508b5dd94f3cf607e361423cfd4b1173796dffb8fe32585ac9b2cb99b4", "alice:Morpho:PT-apyUSD", 3481.31, "manual", 0.005, "Σ USDC на закуп PT $3484 (своё+заёмное), плечо ~3×; fix 137141d"],
  ["POS-003", A1, "eth", "morphoblue", "0x92a6a01b07984de46c24e8eba248449beb8b1dcb", "0x71d0e75da4e37b7edd68c336521e67c247a59c1b6d93f66d17f812e1b4d0114a", "alice:Morpho:PT-apxUSD", 1405.00, "manual", 0.005, "Σ USDC на закуп PT $1406 (своё+заёмное), плечо ~2.6×; fix 137141d"],
  ["POS-004", A1, "base", "base_avantisfi", "0x944766f715b51967e56afde5f0aa76ceacc9e7f9", "0xb0a9dc472c7e63ac4e792144f82d2055abdedf2457e4dfe93c25215e9d50c9b7", "alice:Avantis:jUSDC", 1737.25, "manual", 0.005, "swap USDC $1737 → jUSDC (не receipt-спот $1723)"],
  ["POS-005", A1, "eth", "morphoblue", "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb", "0x57164b7c5de7f3de24c7d262634b3ba322d2318f7c3d7e582edba6e887821784", "alice:Morpho:wSPYx", 1073.85, "manual", 0.005, "wSPYx свопами USDC $1001 + ETH (lot-WAC)"],
  ["POS-006", A1, "arb", "arb_gmx2", "0xdf03eed325b82bc1d4db8b49c30ecc9e05104b96", "0x17cf625b9a1cdccdb3a8cf1d04840157a0b9366e84f88f0ed3190085c1aa8a41", "alice:GMX:GM-WBTC-USDC", 1300.00, "manual", 0.005, "GMX async-deposit USDC $1300 (linker 981c9d0)"],
  ["POS-007", A1, "eth", "uniswap3", "1221698", "0x4ebc5cd6f9355c1fc272b809a938a18f201e08d9fa2dd704ee37cf760e4ceb7a", "alice:UniV3:EURC-USDC", 1121.82, "krystal", 0.02, "LP V3 (LP-truth=Krystal)"],
  ["POS-008", A1, "arb", "arb_gmx2", "0x47c031236e19d024b42f8ae6780e44a573170703", "0x2d2364d05f76d940d7d7957ae8ad050acefbde693d3c0df0ea5f113a42c5edb7", "alice:GMX:GLV-WBTC-USDC", 1498.80, "manual", 0.005, "GMX async-deposit USDC $1498.80 (linker 981c9d0)"],
  ["POS-009", A2, "eth", "uniswap3", "1159873", "0xa4b7940802fa46b801102989ed5d363beb1579004893c680ce3e5234db7ec3c9", "alice:UniV3:PAXG-USDC-1159873", 228.11, "krystal", 0.02, "LP V3 (LP-truth=Krystal)"],
  ["POS-010", A3, "eth", "uniswap3", "1215711", "0x23fb8145b12d67abb47576049d749fc87e88d37ea14eb8e07e7d87ed5eb16838", "alice:UniV3:WBTC-USDC-1215711", 1568.45, "krystal", 0.02, "LP V3 (LP-truth=Krystal)"],
  ["POS-011", A2, "eth", "uniswap3", "1219136", null, "alice:UniV3:PAXG-USDC-1219136", 1180.86, "krystal", 0.02, "LP V3 orphan NFT (LP-truth=Krystal)"],
  ["POS-012", A2, "eth", "uniswap3", "1159369", "0x33e506f3e8e19c1ed80eee6e753c46b63fe1ed972acba4b07d29c522d33bb13f", "alice:UniV3:XAUt-USDT", 159.12, "krystal", 0.02, "LP V3 (LP-truth=Krystal)"],
];

async function main() {
  const admin = await db.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.role, "admin")).limit(1);
  const createdBy = admin[0]?.id ?? null;
  let ok = 0;
  for (const [posId, wallet, chain, proto, market, openHash, label, startUsd, source, tolPct, note] of ROWS) {
    const key = `alice-2026-06-04:${posId}`;
    // Direct insert (fresh keys; partial position_key index breaks ON CONFLICT
    // arbiter on this dev DB where migration 0032 isn't applied). Idempotent via
    // pre-delete by positionKey.
    await db.db.delete(schema.goldenCases).where(eq(schema.goldenCases.positionKey, key));
    await db.db.insert(schema.goldenCases).values({
      walletId: wallet,
      positionId: posId,
      positionKey: key,
      chain,
      protocolId: proto,
      marketKey: market,
      openHash,
      label,
      kind: "golden",
      issue: null,
      expectedStartUsd: String(startUsd),
      expectedNetStartUsd: String(startUsd),
      expectedPnlUsd: null,
      toleranceAbsUsd: "1",
      tolerancePct: String(tolPct),
      sourceOfTruth: source,
      provenanceNote: note,
      methodologyVersion: "ucb@137141d",
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
main().catch((e) => { console.error(e); process.exit(1); });
