/** One-off: run the anomaly detector for an account and print findings. */
import { createDbClient } from "@cap-flow/db";

import { AccountsRepository } from "../src/modules/accounts/accounts.repository.js";
import { WalletsRepository } from "../src/modules/wallets/wallets.repository.js";
import { UcbShadowRepository } from "../src/modules/ucb/ucb-shadow.repository.js";
import { GoldenRepository } from "../src/modules/golden/golden.repository.js";
import { AnomalyFlagsRepository } from "../src/modules/anomaly/anomaly-flags.repository.js";
import { AnomalyDetectorService } from "../src/modules/anomaly/anomaly-detector.service.js";

const ACCOUNT = process.argv[2] ?? "d96e847e-f030-47e5-82d6-8b0d5b2cf01f";
const db = createDbClient({ connectionString: process.env.DATABASE_URL ?? "", max: 4, idleTimeoutMillis: 10_000 });
const walletsRepo = new WalletsRepository(db.db);
const svc = new AnomalyDetectorService({
  shadowRepo: new UcbShadowRepository(db.db),
  goldenRepo: new GoldenRepository(db.db),
  flagsRepo: new AnomalyFlagsRepository(db.db),
  walletIdsForAccount: async (accountId: string) =>
    (await walletsRepo.listByAccount(accountId)).map((w) => w.id),
  detectorVersion: "detector@manual-scan",
  accounts: new AccountsRepository(db.db),
});

const res = await svc.scanAccount(ACCOUNT);
console.log(JSON.stringify(res, null, 2));
await db.pool.end();
process.exit(0);
