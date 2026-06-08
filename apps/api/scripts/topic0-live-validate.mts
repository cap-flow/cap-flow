/**
 * topic0 этап 1.2 — ЖИВАЯ валидация (read-only, НЕ мутирует chain_operations).
 *
 * Поднимает ChainClassifierService точь-в-точь как worker.ts (реальный DeBank
 * fetcher + Alchemy log-fetch адаптер), прогоняет analyzeAccount для аккаунта
 * ДВАЖДЫ — topic0 OFF (baseline) и ON (enriched) — и диффит op_type по хэшам.
 * Показывает, что именно topic0 поправил на реальных данных + стоимость фетча.
 *
 * Run: cd apps/api && npx tsx --env-file=../../.env scripts/topic0-live-validate.mts <accountId>
 */
import { createDbClient } from "@cap-flow/db";
import { sql } from "drizzle-orm";

import { loadEnv } from "../src/config/env.js";
import { DeBankClient } from "../src/modules/integrations/debank.js";
import {
  ChainClassifierService,
  type EvmHistoryFetcher,
} from "../src/modules/classifier/chain_classifier.service.js";
import { makeAlchemyEvmLogsFetcher } from "../src/modules/classifier/evm_logs_fetcher.js";
import type { ClassifiedOp } from "../src/modules/classifier/types.js";

const accountId = process.argv[2];
if (!accountId) {
  console.error("usage: topic0-live-validate.mts <accountId>");
  process.exit(1);
}

const env = loadEnv();
if (!env.DEBANK_API_KEY) {
  console.error("DEBANK_API_KEY missing");
  process.exit(1);
}
if (!env.ALCHEMY_API_KEY) {
  console.error("ALCHEMY_API_KEY missing");
  process.exit(1);
}

const db = createDbClient({ connectionString: env.DATABASE_URL, max: 4 });

interface AddrRow {
  address: string;
  type: string;
}

// Флаг-стаб с управляемым topic0.
let topic0On = false;
const flags = {
  // eslint-disable-next-line @typescript-eslint/require-await
  enabled: async (key: string) => {
    if (key === "chain_classifier.enabled") return true;
    if (key === "chain_classifier.topic0.enabled") return topic0On;
    return false;
  },
};

const debankClient = new DeBankClient(env.DEBANK_API_KEY);
const evmHistoryFetcher: EvmHistoryFetcher = async (address) =>
  (await debankClient.getHistory(address)) as unknown as Awaited<
    ReturnType<EvmHistoryFetcher>
  >;
const evmLogsFetcher = makeAlchemyEvmLogsFetcher(env.ALCHEMY_API_KEY);

const svc = new ChainClassifierService(
  flags,
  evmHistoryFetcher,
  null,
  evmLogsFetcher
);

function flatten(byAddr: ReadonlyMap<string, readonly ClassifiedOp[]>) {
  const m = new Map<string, ClassifiedOp>();
  for (const ops of byAddr.values()) {
    for (const op of ops) m.set(`${op.chain}:${op.hash}`, op);
  }
  return m;
}

async function main() {
  const res = await db.db.execute<AddrRow>(sql`
    SELECT wa.address, wa.type
    FROM wallet_addresses wa JOIN wallets w ON w.id = wa.wallet_id
    WHERE w.account_id = ${accountId} AND wa.type = 'evm'
  `);
  const addresses = res.rows.map((r) => ({ address: r.address, type: "evm" }));
  console.log(`[validate] ${addresses.length} EVM-адресов для ${accountId.slice(0, 8)}\n`);
  if (addresses.length === 0) {
    await db.close();
    return;
  }

  // Baseline (topic0 OFF).
  topic0On = false;
  const t0 = Date.now();
  const base = await svc.analyzeAccount({ accountId, addresses });
  console.log(
    `[baseline OFF] classified=${base.classified}, errors=${base.errors.length}, ${Date.now() - t0}ms`
  );

  // Enriched (topic0 ON).
  topic0On = true;
  const t1 = Date.now();
  const enr = await svc.analyzeAccount({ accountId, addresses });
  console.log(
    `[enriched ON] classified=${enr.classified}, errors=${enr.errors.length}, ${Date.now() - t1}ms`
  );
  if (enr.errors.length > 0) {
    console.log("  errors:", enr.errors.slice(0, 5));
  }

  // Diff per hash.
  const baseMap = flatten(base.opsByAddress);
  const enrMap = flatten(enr.opsByAddress);
  const changes: string[] = [];
  let topic0Tagged = 0;
  for (const [key, eop] of enrMap) {
    const bop = baseMap.get(key);
    const t0note = (eop.notes ?? []).find((n) => n.startsWith("topic0:"));
    if (t0note) topic0Tagged++;
    if (bop && bop.type !== eop.type) {
      changes.push(
        `  ${key.slice(0, 18)}… : ${bop.type} → ${eop.type}  (${t0note ?? "?"}${eop.protocol ? `, ${eop.protocol.id}` : ""})`
      );
    }
  }

  console.log(`\n=== topic0-обогащённых ops (есть logs+событие): ${topic0Tagged} ===`);
  console.log(`=== ИЗМЕНЕНИЯ op_type (baseline → enriched): ${changes.length} ===`);
  console.log(changes.length ? changes.join("\n") : "  нет изменений");

  // Распределение по типам (enriched).
  console.log("\n=== byType (enriched) ===");
  for (const [t, n] of Object.entries(enr.byType).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))) {
    console.log(`  ${t}: ${n}`);
  }

  await db.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
