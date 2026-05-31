/**
 * A3 dev smoke test: exercises GoldenRepository against the local DB —
 * createGolden → list → patch → (insert test anomaly) → promote → cleanup.
 * Run: DATABASE_URL=... tsx src/scripts/golden-smoke.ts <walletId> <accountId>
 * NOT a CI test; a throwaway runtime check of the Drizzle queries.
 */
import { createDbClient, schema } from "@cap-flow/db";
import { eq } from "drizzle-orm";

import { GoldenRepository } from "../modules/golden/golden.repository.js";

const walletId = process.argv[2]!;
const accountId = process.argv[3]!;
const databaseUrl = process.env["DATABASE_URL"]!;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
  console.log("  ✓ " + msg);
}

async function main(): Promise<void> {
  const client = createDbClient({ connectionString: databaseUrl });
  const repo = new GoldenRepository(client.db);
  const created: string[] = [];
  const anomalies: string[] = [];
  try {
    console.log("1) createGolden");
    const g = await repo.createGolden({
      walletId,
      positionId: "POS-SMOKE",
      positionKey: "smoke|POS-SMOKE",
      chain: "op",
      protocolId: "op_velodrome",
      marketKey: "3427422",
      openHash: null,
      label: "SMOKE-POS-011",
      kind: "golden",
      derivation: null,
      issue: null,
      expectedStartUsd: 237.8,
      expectedNetStartUsd: null,
      expectedPnlUsd: null,
      toleranceAbsUsd: 1,
      tolerancePct: 0.02,
      sourceOfTruth: "etherscan_v2",
      provenanceNote: "smoke",
      methodologyVersion: "ucb-2026-05-30",
      fixturePath: null,
      createdByUserId: null,
      promotedFromAnomalyId: null,
    });
    created.push(g.id);
    assert(g.label === "SMOKE-POS-011", "golden created");
    assert(Number(g.expectedStartUsd) === 237.8, "numeric round-trips (237.8)");
    assert(g.status === "active", "default status active");

    console.log("2) listGolden(walletId) finds it");
    const list = await repo.listGolden({ walletId });
    assert(list.some((r) => r.id === g.id), "appears in wallet-scoped list");

    console.log("3) patchGolden → retire");
    const patched = await repo.patchGolden(g.id, { status: "retired", tolerancePct: 0.05 });
    assert(patched?.status === "retired", "status retired");
    assert(Number(patched?.tolerancePct) === 0.05, "tolerancePct patched");

    console.log("4) insert test anomaly + promote → golden");
    const [anom] = await client.db
      .insert(schema.anomalyFlags)
      .values({
        accountId,
        walletId,
        positionId: "POS-SMOKE-ANOM",
        chain: "op",
        protocolId: "op_velodrome",
        marketKey: "3427422",
        checkId: "smoke_check",
        severity: "error",
      })
      .returning();
    anomalies.push(anom!.id);
    const promo = await repo.promoteAnomaly(anom!.id, {
      walletId,
      positionId: "POS-SMOKE-ANOM",
      positionKey: "smoke|POS-SMOKE-ANOM",
      chain: "op",
      protocolId: "op_velodrome",
      marketKey: "3427422",
      openHash: null,
      label: "SMOKE-PROMOTED",
      kind: "golden",
      derivation: null,
      issue: null,
      expectedStartUsd: 100,
      expectedNetStartUsd: null,
      expectedPnlUsd: null,
      toleranceAbsUsd: 1,
      tolerancePct: 0.02,
      sourceOfTruth: "manual",
      provenanceNote: "promoted",
      methodologyVersion: "ucb-2026-05-30",
      fixturePath: null,
      createdByUserId: null,
      promotedFromAnomalyId: anom!.id,
    });
    created.push(promo.golden.id);
    assert(promo.anomaly.status === "promoted", "anomaly marked promoted");
    assert(promo.anomaly.goldenCaseId === promo.golden.id, "bidirectional link set");
    assert(promo.golden.promotedFromAnomalyId === anom!.id, "golden links back to anomaly");

    console.log("\nALL SMOKE ASSERTS PASSED ✓");
  } finally {
    // cleanup
    for (const id of anomalies) {
      await client.db.delete(schema.anomalyFlags).where(eq(schema.anomalyFlags.id, id));
    }
    for (const id of created) {
      await client.db.delete(schema.goldenCases).where(eq(schema.goldenCases.id, id));
    }
    console.log("cleanup done");
    await client.close();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
