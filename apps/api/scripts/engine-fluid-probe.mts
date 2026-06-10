/**
 * Ground-truth probe: прогоняем РЕАЛЬНЫЙ движок (linkAsyncDeposits →
 * buildLotsAndPositions) на ops Artur'а с боевыми histPrices и печатаем
 * стоимость КАЖДОГО Fluid-supply консьюма + ключевые лоты (GM 0x450b,
 * borrow self-loop WBTC, claims). Сравнение с эталонным WAC-трейсом.
 */
import { createDbClient } from "@cap-flow/db";
import { linkAsyncDeposits } from "@cap-flow/ucb/async_deposit_linker";
import { buildLotsAndPositions } from "@cap-flow/ucb/positions/cross_protocol";
import type { ClassifiedOp } from "@cap-flow/ucb/types";

import { OpPricingService } from "../src/modules/ucb/op-pricing.service.js";
import { OpPricingRepository } from "../src/modules/ucb/op-pricing.repository.js";

const WALLET = "fe29e539-3d9e-4fb0-8d85-7351cbd63ab8";
const db = createDbClient({ connectionString: process.env.DATABASE_URL ?? "", max: 2, idleTimeoutMillis: 5_000 });

const rows = await db.pool.query(
  `SELECT raw FROM chain_operations WHERE wallet_id=$1 ORDER BY (raw->>'time')::numeric ASC`,
  [WALLET],
);
const rawOps: ClassifiedOp[] = rows.rows.map((r: any) => r.raw);
console.log(`[probe] ${rawOps.length} ops`);

const pricing = new OpPricingService(new OpPricingRepository(db.db));
const { histPrices } = await pricing.priceMapForOps(rawOps);
console.log(`[probe] histPrices entries: ${histPrices.size}`);

const ops = linkAsyncDeposits(rawOps);

// monkey-patch: перехватываем consume/acquire LotTracker'а не будем — вместо
// этого читаем итоговые лоты + восстанавливаем consume-цены через wacAt.
const { lots } = buildLotsAndPositions(ops, WALLET, {
  histPrices,
  walletNameById: new Map([[WALLET, "Artur"]]),
});

const d = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
const f = (n: number, k = 2) => n.toLocaleString("en-US", { minimumFractionDigits: k, maximumFractionDigits: k });

// Fluid supplies из ops: для каждой — wacAt(symbol, time-1) = WAC на момент ДО консьюма
console.log("\n══ Fluid supplies: WAC движка на момент supply (см. C11 wacAt) ══");
for (const op of ops) {
  if (op.type !== "lend_supply" || op.protocol?.id !== "arb_fluid") continue;
  for (const m of op.movement ?? []) {
    if (m.direction !== "out" || m.amount <= 0) continue;
    if (m.symbol === "fVLT") continue;
    const wac = lots.wacAt(WALLET, m.symbol, op.time - 1);
    console.log(
      `  ${d(op.time)}  -${m.amount} ${m.symbol}  WAC@supply=${wac == null ? "null" : "$" + f(wac)}  → cost=${wac == null ? "?" : "$" + f(wac * m.amount)}`,
    );
  }
}

console.log("\n══ ВСЕ лоты ETH/WBTC/GM (включая потреблённые) ══");
for (const sym of ["ETH", "WBTC", "GM"]) {
  const all = lots.getLots(WALLET, sym);
  for (const l of all) {
    const orig = (l.consumes ?? []).reduce((s: number, c: any) => s + c.amount, 0) + l.amount;
    console.log(
      `  [${sym}] tok=${(l.tokenId || "—").slice(0, 10)} via=${l.acquiredVia} @${d(l.acquiredAt)}  orig=${f(orig, 6)} left=${f(l.amount, 6)}  cost/unit=$${f(l.costPerUnitUsd)}  totalCost=$${f(orig * l.costPerUnitUsd)}`,
    );
  }
}

await db.pool.end();
process.exit(0);
