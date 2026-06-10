/** Trace: cost basis the engine assigns to yesterday's GMX withdrawal legs
 *  (WETH/WBTC) that then flowed into Fluid. Shows attributed-from-deposit vs
 *  withdrawal-time spot, and GM WAC (symbol-keyed) at the moment. */
import { createDbClient } from "@cap-flow/db";
import {
  buildCostBasisTracker,
  computeLpCloseAttribution,
} from "@cap-flow/ucb/cost_basis_tracker";

const WALLET = "fe29e539-3d9e-4fb0-8d85-7351cbd63ab8"; // Artur
const dbClient = createDbClient({
  connectionString: process.env.DATABASE_URL ?? "",
  max: 2,
  idleTimeoutMillis: 5_000,
});

const rows = await dbClient.pool.query(
  `SELECT raw FROM chain_operations WHERE wallet_id=$1 ORDER BY (raw->>'time')::numeric ASC NULLS FIRST`,
  [WALLET],
);
const ops = rows.rows.map((r) => r.raw);
console.log(`[trace] loaded ${ops.length} ops for Artur`);

const histPrices = new Map(); // empty → movementUsd falls back to m.usd (DeBank-priced)
const attribution = computeLpCloseAttribution(ops, histPrices);
const tracker = buildCostBasisTracker(ops, histPrices);

// Yesterday's 3 executeWithdrawal hashes (GM burned → USDC + WETH/WBTC received)
const closes = [
  { tag: "GM 0x70d9 (WETH/USDC)", hash: "0xfe1ff997788d36fedf95dcfa4cbf96f479192411aa994db709cd3be567c07024" },
  { tag: "GM 0x77b2 (WETH/USDC)", hash: "0xf23c10a429784e5c06addab4a5793325943a11fdf31f2ca4b9bebb618663b050" },
  { tag: "GM 0x47c0 (WBTC/USDC)", hash: "0x5a82b2c6474f68177529150b07142d9edf6797d43b161412ede07cfdcca8a056" },
];

// Gross pooled deposit across ALL arb_gmx2 (the attribution denominator)
let grossDeposit = 0, grossCloseRecv = 0;
for (const op of ops as any[]) {
  if (op.protocol?.id !== "arb_gmx2" || op.chain !== "arb") continue;
  for (const m of op.movement ?? []) {
    if (m.direction === "out" && m.amount > 0 && op.type === "lp_add") grossDeposit += m.usd ?? 0;
    if (m.direction === "in" && m.amount > 0 && op.type === "lp_remove") grossCloseRecv += m.usd ?? 0;
  }
}
console.log(`\n[POOL arb_gmx2] gross lp_add USD = $${grossDeposit.toFixed(0)}  |  gross lp_remove recv USD = $${grossCloseRecv.toFixed(0)}`);
console.log(`(депозит пулится по протоколу+сети, БЕЗ разделения GM-токенов; каждый ре-депозит копится → gross раздут)`);

for (const c of closes) {
  const op = ops.find((o: any) => o.hash === c.hash);
  const attr = attribution.get(c.hash); // keyed by NORMALIZED symbol
  console.log(`\n━━ ${c.tag}  (${c.hash.slice(0, 12)}…) ━━`);
  if (!op) { console.log("  op not found"); continue; }
  const closeRecv = (op.movement as any[]).filter((m) => m.direction === "in" && m.amount > 0).reduce((s, m) => s + (m.usd ?? 0), 0);
  console.log(`  реально получено активов: $${closeRecv.toFixed(2)}`);
  for (const [sym, a] of (attr ?? new Map())) {
    console.log(`  [${sym}] amount=${a.amount}  ATTRIBUTED cost basis=$${a.costUsd.toFixed(2)}`);
  }
}

// Does it propagate? ETH/WBTC WAC at the 3 Fluid supply times vs Fluid position startUsd.
console.log(`\n━━ итоговый WAC на момент завода в Fluid (это и есть cost basis Fluid-ноги) ━━`);
const fluidSupplies = [
  { sym: "ETH", time: 1781007173 }, // 12:12:53? use op lookup below
];
for (const hash of [
  "0xc105b0bef991dc8964096113ef712ba0d5ba223b967135c6cc2977db5922a1d6", // ETH→Fluid 12:12
  "0x40b4db3d335f72462393105d59b42f7c4b6104b3293b798e3dd93281ae731ebe", // ETH→Fluid 12:21
  "0xa057436e6c4461dcee0c052f791b7e9b8657a457c8434f43a9f0de86363d70f7", // WBTC→Fluid 12:33
]) {
  const op = ops.find((o: any) => o.hash === hash);
  if (!op) { console.log(`  ${hash.slice(0,10)} not found`); continue; }
  const m = (op.movement as any[]).find((x) => x.direction === "out" && x.amount > 0);
  const wac = tracker.avgAt("ETH", op.time);
  const wacB = tracker.avgAt(m.symbol, op.time);
  console.log(`  Fluid supply ${m.amount} ${m.symbol}: WAC(${m.symbol})=${wacB==null?"null":"$"+wacB.toFixed(2)}  → cost=$${wacB==null?"?":(wacB*m.amount).toFixed(2)}  (spot=$${(m.usd??0).toFixed(2)})`);
}

await dbClient.pool.end();
process.exit(0);
