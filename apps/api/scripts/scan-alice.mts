/** One-off: run the anomaly detector for Alice → prove golden_case_drift loop. */
import { createDbClient } from "@cap-flow/db";
import { AnomalyDetectorService } from "../src/modules/anomaly/anomaly-detector.service.js";
import { AnomalyFlagsRepository } from "../src/modules/anomaly/anomaly-flags.repository.js";
import { UcbShadowRepository } from "../src/modules/ucb/ucb-shadow.repository.js";
import { GoldenRepository } from "../src/modules/golden/golden.repository.js";
import { WalletsRepository } from "../src/modules/wallets/wallets.repository.js";

const db = createDbClient({ connectionString: process.env.DATABASE_URL ?? "", max: 2 });
const walletsRepo = new WalletsRepository(db.db);
const detector = new AnomalyDetectorService({
  shadowRepo: new UcbShadowRepository(db.db),
  goldenRepo: new GoldenRepository(db.db),
  flagsRepo: new AnomalyFlagsRepository(db.db),
  walletIdsForAccount: async (id) => (await walletsRepo.listByAccount(id)).map((w) => w.id),
  detectorVersion: "scan-alice@dev",
});

const r = await detector.scanAccount("083b22d7-3ef5-445f-a9a5-a537b2d847f5");
console.log("[scan]", JSON.stringify(r));
await db.close();
