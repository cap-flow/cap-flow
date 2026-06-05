/**
 * Shadow-diff topic0 (этап 1, read-only): прогоняет classifyByTopic0 на реальных
 * логах tx одного аккаунта и диффит против текущего chain_operations.op_type.
 * НИЧЕГО не пишет, live-refresh не трогает. Валидация на реальных данных перед
 * живым вживлением (см. classifier-upgrade-plan.md этап 1).
 *
 * Run: cd apps/api && npx tsx --env-file=../../.env scripts/classifier-topic0-shadow.mts <accountId> [limit]
 */
import { createDbClient } from "@cap-flow/db";
import { sql } from "drizzle-orm";
import { createPublicClient, http, type PublicClient } from "viem";
import { mainnet, optimism, bsc, polygon, base, arbitrum, avalanche } from "viem/chains";
import { classifyByTopic0, type Topic0Log } from "@cap-flow/ucb/topic0_dict";

const accountId = process.argv[2];
const LIMIT = Number(process.argv[3] ?? 150);
if (!accountId) { console.error("usage: classifier-topic0-shadow.mts <accountId> [limit]"); process.exit(1); }

const ALCHEMY = process.env.ALCHEMY_API_KEY ?? "";
if (!ALCHEMY) { console.error("ALCHEMY_API_KEY missing"); process.exit(1); }

// chain string → {viem chain, alchemy host}. Только поддерживаемые Alchemy.
const CHAINS: Record<string, { chain: any; host: string }> = {
  eth: { chain: mainnet, host: "eth-mainnet.g.alchemy.com" },
  op: { chain: optimism, host: "opt-mainnet.g.alchemy.com" },
  bsc: { chain: bsc, host: "bnb-mainnet.g.alchemy.com" },
  matic: { chain: polygon, host: "polygon-mainnet.g.alchemy.com" },
  base: { chain: base, host: "base-mainnet.g.alchemy.com" },
  arb: { chain: arbitrum, host: "arb-mainnet.g.alchemy.com" },
  avax: { chain: avalanche, host: "avax-mainnet.g.alchemy.com" },
};
const clients = new Map<string, PublicClient>();
function clientFor(chain: string): PublicClient | null {
  const c = CHAINS[chain];
  if (!c) return null;
  let cl = clients.get(chain);
  if (!cl) {
    cl = createPublicClient({ chain: c.chain, transport: http(`https://${c.host}/v2/${ALCHEMY}`, { batch: true }) });
    clients.set(chain, cl);
  }
  return cl;
}

const db = createDbClient({ connectionString: process.env.DATABASE_URL ?? "", max: 4 });

interface Row { chain: string; tx_hash: string; op_type: string; category: string | null }

async function main() {
  const res = await db.db.execute<Row>(sql`
    SELECT DISTINCT ON (co.chain, co.tx_hash)
      co.chain, co.tx_hash, co.op_type,
      co.raw->'protocol'->>'category' AS category
    FROM chain_operations co JOIN wallets w ON w.id=co.wallet_id
    WHERE w.account_id=${accountId} AND co.status<>'failed'
      AND co.chain IN ('eth','op','bsc','matic','base','arb','avax')
      AND co.op_type NOT IN ('noise','approve','transfer_in','transfer_out','failed','gas_topup')
    ORDER BY co.chain, co.tx_hash
    LIMIT ${LIMIT}
  `);
  const rows = res.rows;
  console.log(`[shadow] ${rows.length} tx на поддерживаемых сетях (лимит ${LIMIT})\n`);

  const tally = { agree: 0, disagree: 0, noSignal: 0, noReceipt: 0 };
  const disagreements: string[] = [];
  let i = 0;
  const CONC = 5;
  async function worker() {
    while (i < rows.length) {
      const r = rows[i++]!;
      const cl = clientFor(r.chain);
      if (!cl) { tally.noReceipt++; continue; }
      try {
        const rcpt = await cl.getTransactionReceipt({ hash: r.tx_hash as `0x${string}` });
        const logs: Topic0Log[] = rcpt.logs
          .filter((l) => l.topics[0])
          .map((l) => ({ address: l.address.toLowerCase(), topic0: l.topics[0]!.toLowerCase() }));
        const t0 = classifyByTopic0(logs, { protocolCategory: (r.category as any) ?? null });
        if (!t0) { tally.noSignal++; continue; }
        if (t0.opType === r.op_type) tally.agree++;
        else {
          tally.disagree++;
          disagreements.push(`  ${r.chain} ${r.tx_hash.slice(0, 12)}… : ${r.op_type} → ${t0.opType}  (${t0.event}${r.category ? `, cat=${r.category}` : ""})`);
        }
      } catch {
        tally.noReceipt++;
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  console.log("=== РАСХОЖДЕНИЯ (topic0 предлагает другой op_type) ===");
  console.log(disagreements.length ? disagreements.join("\n") : "  нет");
  console.log("\n=== ИТОГ ===");
  console.log(`  agree     (совпало с текущим): ${tally.agree}`);
  console.log(`  disagree  (topic0 поправил):   ${tally.disagree}`);
  console.log(`  no-signal (нет события в словаре / data-decode): ${tally.noSignal}`);
  console.log(`  no-receipt (нет логов / unsupported): ${tally.noReceipt}`);
  await db.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
