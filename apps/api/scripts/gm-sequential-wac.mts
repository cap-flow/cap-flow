/**
 * Registry-trace: sequential per-token WAC for GMX GM markets (owner methodology,
 * locked 2026-06-10):
 *   - buy:  price = nominal stable paid / GM received (per specific GM token)
 *   - sell: consume at the WAC effective AT THAT MOMENT
 *   - stable leg of a withdrawal takes face value; the REMAINDER of consumed
 *     basis goes to the volatile leg (its inherited per-unit price printed)
 *   - WAC recomputes after every buy; consumption does not change per-unit WAC
 * Prints a step-by-step verification table per market + compares the final
 * (qty, basis) against the latest server shadow result.
 */
import { createDbClient } from "@cap-flow/db";

const WALLET = "fe29e539-3d9e-4fb0-8d85-7351cbd63ab8"; // testakk / Artur
const ACCOUNT = "d96e847e-f030-47e5-82d6-8b0d5b2cf01f";
const STABLES = new Set(["USDC", "USD₮0", "USDT", "DAI", "GHO"]);

const MARKETS = [
  { token: "0x70d95587d40a2caf56bd97485ab3eec10bee6336", tag: "GM WETH/USDC — 0x70d9" },
  { token: "0x77b2ec357b56c7d05a87971db0188dbb0c7836a5", tag: "GM WETH/USDC — 0x77b2" },
  { token: "0x47c031236e19d024b42f8ae6780e44a573170703", tag: "GM WBTC/USDC — 0x47c0" },
];

const db = createDbClient({
  connectionString: process.env.DATABASE_URL ?? "",
  max: 2,
  idleTimeoutMillis: 5_000,
});

const opsRows = await db.pool.query(
  `SELECT raw FROM chain_operations WHERE wallet_id=$1`,
  [WALLET],
);
type Op = any;
const ops: Op[] = opsRows.rows.map((r: any) => r.raw).sort((a: Op, b: Op) => a.time - b.time);
const byHash = new Map(ops.map((o) => [o.hash, o]));

// latest server shadow startUsd per lpTokenId (for the comparison footer)
const shadowRows = await db.pool.query(
  `SELECT positions FROM ucb_shadow_results WHERE account_id=$1 ORDER BY computed_at DESC LIMIT 1`,
  [ACCOUNT],
);
const serverByLp = new Map<string, number>();
for (const p of shadowRows.rows[0]?.positions ?? []) {
  if (p.lpTokenId) serverByLp.set(p.lpTokenId, p.startUsd);
}

const d = (t: number) => new Date(t * 1000).toISOString().replace("T", " ").slice(0, 16);
const f = (n: number, k = 2) => n.toLocaleString("en-US", { minimumFractionDigits: k, maximumFractionDigits: k });

const usedPairs = new Set<string>();
/** Tx A (multicall платит стейбл) для executeDeposit, или Tx B
 *  (executeWithdrawal возвращает ноги) для multicall-burn. linkedHash в raw
 *  пуст (линкер работает в движке), поэтому матчим по типу+времени (±300с,
 *  ближайший, один раз). */
function pairFor(op: Op, want: "payment" | "legs"): Op | null {
  if (op.linkedHash && byHash.has(op.linkedHash)) return byHash.get(op.linkedHash);
  const cands = ops.filter((o) => {
    if (o.hash === op.hash || usedPairs.has(o.hash)) return false;
    if (o.type !== op.type) return false;
    if (o.protocol?.id !== "arb_gmx2") return false;
    if (Math.abs(o.time - op.time) > 300) return false;
    const mv = (o.movement ?? []) as any[];
    if (want === "payment")
      return o.fnName === "multicall" && mv.some((m) => m.direction === "out" && STABLES.has(m.symbol) && m.amount > 0);
    return o.fnName === "executeWithdrawal" && mv.some((m) => m.direction === "in" && m.amount > 0);
  });
  cands.sort((a, b) => Math.abs(a.time - op.time) - Math.abs(b.time - op.time));
  const hit = cands[0] ?? null;
  if (hit) usedPairs.add(hit.hash);
  return hit;
}

for (const mkt of MARKETS) {
  console.log(`\n━━━━━━━━━━ ${mkt.tag} ━━━━━━━━━━`);
  interface Ev {
    kind: "buy" | "burn";
    time: number;
    hash: string;
    gm: number;
    paidStable?: number;
    paidOtherNote?: string[];
    legs?: { symbol: string; amount: number; usd: number; stable: boolean }[];
  }
  const events: Ev[] = [];

  for (const op of ops) {
    const mv = (op.movement ?? []) as any[];
    const gmIn = mv.filter((m) => m.tokenId === mkt.token && m.direction === "in" && m.amount > 0)
      .reduce((s, m) => s + m.amount, 0);
    const gmOut = mv.filter((m) => m.tokenId === mkt.token && m.direction === "out" && m.amount > 0)
      .reduce((s, m) => s + m.amount, 0);

    if (gmIn > 0) {
      // payment lives in this op and/or the paired Tx A (multicall)
      const pair = pairFor(op, "payment");
      let paidStable = 0;
      const paidOtherNote: string[] = [];
      const seen = new Set<string>();
      for (const src of [op, pair].filter(Boolean) as Op[]) {
        if (seen.has(src.hash)) continue;
        seen.add(src.hash);
        for (const m of (src.movement ?? []) as any[]) {
          if (m.direction !== "out" || m.amount <= 0) continue;
          if (m.tokenId === mkt.token) continue;
          if ((m.symbol === "ETH" || m.symbol === "WETH") && m.amount < 0.01) continue; // gas dust
          if (STABLES.has(m.symbol)) paidStable += m.amount;
          else paidOtherNote.push(`${m.amount} ${m.symbol} ($${f(m.usd ?? 0)})`);
        }
      }
      events.push({ kind: "buy", time: op.time, hash: op.hash, gm: gmIn, paidStable, paidOtherNote });
    }

    if (gmOut > 0) {
      const pair = pairFor(op, "legs");
      const legSrc = pair ?? op;
      const legs = ((legSrc.movement ?? []) as any[])
        .filter((m) => m.direction === "in" && m.amount > 0)
        .filter((m) => !(m.symbol === "ETH" && m.amount < 0.001)) // keeper fee refund dust
        .map((m) => ({
          symbol: m.symbol,
          amount: m.amount,
          usd: m.usd ?? 0,
          stable: !!m.isStable || STABLES.has(m.symbol),
        }));
      events.push({ kind: "burn", time: op.time, hash: op.hash, gm: gmOut, legs });
    }
  }

  events.sort((a, b) => a.time - b.time);

  let qty = 0;
  let basis = 0;
  for (const e of events) {
    if (e.kind === "buy") {
      const paid = e.paidStable ?? 0;
      const px = paid / e.gm;
      qty += e.gm;
      basis += paid;
      console.log(
        `${d(e.time)}  BUY   +${f(e.gm, 6)} GM  за ${f(paid, 6)} стейбла` +
          `  → цена $${px.toFixed(10)}/GM` +
          `  | WAC=${f(basis / qty, 6)}  | qty=${f(qty, 6)}  basis=$${f(basis, 2)}`,
      );
      if (e.paidOtherNote?.length)
        console.log(`        ⚠ нестейбл-оплата (не учтена в стейбл-номинале!): ${e.paidOtherNote.join(", ")}`);
    } else {
      const wac = qty > 0 ? basis / qty : 0;
      const consumed = e.gm * wac;
      const stableFace = (e.legs ?? []).filter((l) => l.stable).reduce((s, l) => s + l.amount, 0);
      const vols = (e.legs ?? []).filter((l) => !l.stable);
      const residual = consumed - stableFace;
      qty -= e.gm;
      basis -= consumed;
      console.log(
        `${d(e.time)}  SELL  -${f(e.gm, 6)} GM  по WAC $${wac.toFixed(10)}/GM` +
          `  → списано базы $${f(consumed, 2)}  | qty=${f(qty, 6)}  basis=$${f(basis, 2)}`,
      );
      console.log(`        стейбл-нога по номиналу: $${f(stableFace, 6)}`);
      const volUsd = vols.reduce((s, l) => s + l.usd, 0);
      for (const l of vols) {
        const share = volUsd > 0 ? l.usd / volUsd : 1 / vols.length;
        const cost = residual * share;
        console.log(
          `        волатильная нога: +${l.amount} ${l.symbol}` +
            `  ← унаследованная база $${f(cost, 2)} (=$${f(cost / l.amount, 2)}/${l.symbol};` +
            ` спот на выводе был $${f(l.usd / l.amount, 2)})`,
        );
      }
      if (vols.length === 0 && Math.abs(residual) > 0.01)
        console.log(`        ⚠ residual $${f(residual, 2)} без волатильной ноги (реализованный PnL?)`);
    }
  }

  const server = serverByLp.get(mkt.token);
  console.log(`  ─────`);
  console.log(`  ИТОГ по методике: Внесено = ${f(qty, 6)} GM, Стартовая $ = $${f(basis, 2)}, WAC = $${qty > 0 ? (basis / qty).toFixed(6) : "-"}/GM`);
  console.log(`  Сервер сейчас:   $${server == null ? "—" : f(server, 2)}  | дельта: ${server == null ? "—" : "$" + f(server - basis, 2)}`);
}

await db.pool.end();
process.exit(0);
