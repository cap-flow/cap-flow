/**
 * Unified chronological simulator — owner methodology (locked 2026-06-10):
 *   - sequential WAC per pool; WAC recomputes after every buy; consumption at
 *     the WAC effective at that moment
 *   - per-GM-token pools (никакого смешивания рынков)
 *   - GM burn: stable leg at face value, residual basis → volatile leg(s)
 *   - ETH=WETH one canonical pool (D4 aliasing); unwrap = no-op
 *   - stable-paid buys at nominal; rewards/fiat-buys at MARKET price at the op
 *     hour (op_token_prices block-fixed cache); borrowed volatile at market
 *   - sell to stable realizes PnL (stable enters at face, chain terminates)
 * Output: GM market tables, ETH/WBTC pool steps, Fluid supplies with inherited
 * cost → expected Fluid startUsd, vs latest server shadow.
 */
import { createDbClient } from "@cap-flow/db";

const WALLET = "fe29e539-3d9e-4fb0-8d85-7351cbd63ab8";
const ACCOUNT = "d96e847e-f030-47e5-82d6-8b0d5b2cf01f";
const STABLES = new Set(["USDC", "USD₮0", "USDT", "DAI", "GHO"]);
const GM_MARKETS = new Set([
  "0x70d95587d40a2caf56bd97485ab3eec10bee6336",
  "0x77b2ec357b56c7d05a87971db0188dbb0c7836a5",
  "0x47c031236e19d024b42f8ae6780e44a573170703",
  "0x450bb6774dd8a756274e0ab4107953259d2ac541",
]);
const ETH_DUST = 0.01;
const WBTC_DUST = 0.0001;

const db = createDbClient({ connectionString: process.env.DATABASE_URL ?? "", max: 2, idleTimeoutMillis: 5_000 });
const opsRows = await db.pool.query(`SELECT raw FROM chain_operations WHERE wallet_id=$1`, [WALLET]);
type Op = any;
const ops: Op[] = opsRows.rows.map((r: any) => r.raw).filter((o: Op) => o.chain === "arb").sort((a: Op, b: Op) => a.time - b.time);
const byHash = new Map(ops.map((o) => [o.hash, o]));

// historical prices (block-fixed cache): hour → usd
const priceRows = await db.pool.query(
  `SELECT coin, hour_bucket, price_usd FROM op_token_prices WHERE priced_ok AND coin IN
   ('arbitrum:0x0000000000000000000000000000000000000000','arbitrum:0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f')`,
);
const hist = new Map<string, number>();
for (const r of priceRows.rows) hist.set(`${r.coin}|${r.hour_bucket}`, Number(r.price_usd));
function histPrice(sym: "ETH" | "WBTC", time: number): number | null {
  const coin = sym === "ETH" ? "arbitrum:0x0000000000000000000000000000000000000000" : "arbitrum:0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f";
  for (let h = 0; h <= 3; h++) {
    const bucket = Math.floor(time / 3600) * 3600 - h * 3600;
    const v = hist.get(`${coin}|${bucket}`);
    if (v != null) return v;
  }
  return null;
}

const shadowRows = await db.pool.query(
  `SELECT positions FROM ucb_shadow_results WHERE account_id=$1 ORDER BY computed_at DESC LIMIT 1`, [ACCOUNT]);
const serverByLp = new Map<string, { startUsd: number; sym: string }>();
for (const p of shadowRows.rows[0]?.positions ?? []) {
  if (p.lpTokenId) {
    const sym = (p.supplyTokens ?? []).map((t: any) => t.symbol).join("+");
    serverByLp.set(`${p.lpTokenId}|${sym}`, { startUsd: p.startUsd, sym });
  }
}

const d = (t: number) => new Date(t * 1000).toISOString().replace("T", " ").slice(0, 16);
const f = (n: number, k = 2) => n.toLocaleString("en-US", { minimumFractionDigits: k, maximumFractionDigits: k });

function canon(sym: string): string {
  if (sym === "WETH") return "ETH";
  return sym;
}

class Pool {
  qty = 0; basis = 0;
  constructor(public name: string, public log: boolean) {}
  wac(): number { return this.qty > 0 ? this.basis / this.qty : 0; }
  buy(amount: number, cost: number, time: number, note: string) {
    this.qty += amount; this.basis += cost;
    if (this.log) console.log(`  ${d(time)}  +${f(amount, 6)} ${this.name} @ $${f(cost / amount, 2)}  (${note})  → WAC $${f(this.wac(), 2)}, qty ${f(this.qty, 6)}, basis $${f(this.basis, 2)}`);
  }
  consume(amount: number, time: number, note: string): number {
    const w = this.wac();
    let cost: number;
    if (amount > this.qty + 1e-9) {
      const deficit = amount - this.qty;
      cost = this.basis + deficit * w;
      console.log(`  ${d(time)}  ⚠ дефицит пула ${this.name}: нужно ${f(amount, 6)}, есть ${f(this.qty, 6)} → дефицит ${f(deficit, 6)} оценён по WAC`);
      this.qty = 0; this.basis = 0;
    } else {
      cost = amount * w;
      this.qty -= amount; this.basis -= cost;
    }
    if (this.log) console.log(`  ${d(time)}  -${f(amount, 6)} ${this.name} @ WAC $${f(w, 2)} → списано $${f(cost, 2)}  (${note})  | qty ${f(this.qty, 6)}, basis $${f(this.basis, 2)}`);
    return cost;
  }
}

const pools = new Map<string, Pool>();
function pool(name: string): Pool {
  let p = pools.get(name);
  if (!p) { p = new Pool(name, name === "ETH" || name === "WBTC"); pools.set(name, p); }
  return p;
}

const usedPairs = new Set<string>();
function pairFor(op: Op, want: "payment" | "legs"): Op | null {
  const cands = ops.filter((o) => {
    if (o.hash === op.hash || usedPairs.has(o.hash)) return false;
    if (o.type !== op.type) return false;
    if (o.protocol?.id !== "arb_gmx2") return false;
    if (Math.abs(o.time - op.time) > 300) return false;
    const mv = (o.movement ?? []) as any[];
    if (want === "payment")
      return o.fnName === "multicall" && mv.some((m) => m.direction === "out" && m.amount > 0 && (STABLES.has(m.symbol) || ((m.symbol === "ETH" || m.symbol === "WETH") && m.amount >= ETH_DUST)));
    return o.fnName === "executeWithdrawal" && mv.some((m) => m.direction === "in" && m.amount > 0);
  });
  cands.sort((a, b) => Math.abs(a.time - op.time) - Math.abs(b.time - op.time));
  const hit = cands[0] ?? null;
  if (hit) usedPairs.add(hit.hash);
  return hit;
}

interface FluidSupply { time: number; sym: string; amount: number; cost: number }
const fluidSupplies: FluidSupply[] = [];
const gmLogs = new Map<string, string[]>();
for (const t of GM_MARKETS) gmLogs.set(t, []);
const consumedWithdrawals = new Set<string>(); // executeWithdrawal hashes already handled as GM legs
const consumedPayments = new Set<string>(); // multicall payment hashes already handled in GM buys

// PRE-PASS: свяжем каждый executeDeposit с его платёжным multicall ЗАРАНЕЕ,
// чтобы generic-ветка не списала оплату из пула до GM-пейринга (multicall
// идёт ПО ВРЕМЕНИ РАНЬШЕ executeDeposit).
const paymentByDeposit = new Map<string, Op | null>();
for (const op of ops) {
  const mv = (op.movement ?? []) as any[];
  const gmIn = mv.find((m) => GM_MARKETS.has(m.tokenId) && m.direction === "in" && m.amount > 0);
  if (!gmIn) continue;
  const pay = pairFor(op, "payment");
  paymentByDeposit.set(op.hash, pay);
  if (pay) consumedPayments.add(pay.hash); // generic-ветка такие ops пропустит
}
const gmPaymentHashes = new Set(consumedPayments);
consumedPayments.clear(); // в основном цикле сет используется заново для дедупа

function isDust(sym: string, amount: number): boolean {
  const c = canon(sym);
  if (c === "ETH") return amount < ETH_DUST;
  if (c === "WBTC") return amount < WBTC_DUST;
  if (c.startsWith("aArb")) return amount < 0.001;
  return false;
}

console.log("══════════ ЕДИНАЯ ХРОНОЛОГИЧЕСКАЯ СИМУЛЯЦИЯ (arb) ══════════");
for (const op of ops) {
  if (op.status === "failed") continue;
  const mv = (op.movement ?? []) as any[];
  const proto = op.protocol?.id ?? "";

  // ── GMX V2 GM markets (per-token pools) ──
  const gmIn = mv.find((m) => GM_MARKETS.has(m.tokenId) && m.direction === "in" && m.amount > 0);
  const gmOut = mv.find((m) => GM_MARKETS.has(m.tokenId) && m.direction === "out" && m.amount > 0);
  if (gmIn) {
    const mkt = gmIn.tokenId as string;
    const pay = paymentByDeposit.get(op.hash) ?? null;
    let cost = 0;
    const parts: string[] = [];
    for (const src of [op, pay].filter(Boolean) as Op[]) {
      if (consumedPayments.has(src.hash)) continue;
      consumedPayments.add(src.hash);
      for (const m of (src.movement ?? []) as any[]) {
        if (m.direction !== "out" || m.amount <= 0) continue;
        if (GM_MARKETS.has(m.tokenId)) continue;
        if (isDust(m.symbol, m.amount)) continue;
        if (STABLES.has(m.symbol)) { cost += m.amount; parts.push(`${f(m.amount, 2)} ${m.symbol} (номинал)`); }
        else {
          const c = pool(canon(m.symbol)).consume(m.amount, op.time, `оплата GM ${mkt.slice(0, 6)}`);
          cost += c; parts.push(`${f(m.amount, 6)} ${m.symbol} по WAC = $${f(c, 2)}`);
        }
      }
    }
    pool(`GM:${mkt.slice(0, 6)}`).buy(gmIn.amount, cost, op.time, "");
    gmLogs.get(mkt)!.push(`${d(op.time)}  BUY  +${f(gmIn.amount, 6)} GM за $${f(cost, 2)} [${parts.join(" + ")}] → цена $${(cost / gmIn.amount).toFixed(10)}/GM, WAC $${pool(`GM:${mkt.slice(0, 6)}`).wac().toFixed(10)}, basis $${f(pool(`GM:${mkt.slice(0, 6)}`).basis, 2)}`);
    continue;
  }
  if (gmOut) {
    const mkt = gmOut.tokenId as string;
    const p = pool(`GM:${mkt.slice(0, 6)}`);
    const wacBefore = p.wac();
    const consumed = p.consume(gmOut.amount, op.time, "");
    const legsOp = pairFor(op, "legs");
    let stableFace = 0;
    const vols: { sym: string; amount: number; usd: number }[] = [];
    if (legsOp) {
      consumedWithdrawals.add(legsOp.hash);
      for (const m of (legsOp.movement ?? []) as any[]) {
        if (m.direction !== "in" || m.amount <= 0 || isDust(m.symbol, m.amount)) continue;
        if (STABLES.has(m.symbol)) stableFace += m.amount;
        else vols.push({ sym: m.symbol, amount: m.amount, usd: m.usd ?? 0 });
      }
    }
    const residual = consumed - stableFace;
    const volUsd = vols.reduce((s, v) => s + v.usd, 0);
    const legNotes: string[] = [];
    for (const v of vols) {
      const share = volUsd > 0 ? v.usd / volUsd : 1 / vols.length;
      const cost = residual * share;
      pool(canon(v.sym)).buy(v.amount, cost, op.time, `нога GM ${mkt.slice(0, 6)}`);
      legNotes.push(`${f(v.amount, 6)} ${v.sym} ← $${f(cost, 2)} ($${f(cost / v.amount, 2)}/шт)`);
    }
    gmLogs.get(mkt)!.push(`${d(op.time)}  SELL -${f(gmOut.amount, 6)} GM по WAC $${wacBefore.toFixed(10)} → списано $${f(consumed, 2)}; стейбл $${f(stableFace, 2)} по номиналу; ${legNotes.join("; ") || "(нет волат. ног)"}; basis после $${f(p.basis, 2)}`);
    continue;
  }
  if (consumedWithdrawals.has(op.hash) || consumedPayments.has(op.hash) || gmPaymentHashes.has(op.hash)) continue;

  // ── swaps ──
  if (op.type === "swap") {
    const ins = mv.filter((m) => m.direction === "in" && m.amount > 0 && !isDust(m.symbol, m.amount));
    const outs = mv.filter((m) => m.direction === "out" && m.amount > 0 && !isDust(m.symbol, m.amount));
    if (ins.length === 1 && outs.length === 1 && canon(ins[0].symbol) === canon(outs[0].symbol)) continue; // unwrap
    let cost = 0;
    for (const m of outs) {
      if (STABLES.has(m.symbol)) cost += m.amount;
      else cost += pool(canon(m.symbol)).consume(m.amount, op.time, `swap → ${ins.map((i) => i.symbol).join("+")}`);
    }
    const nonStableIns = ins.filter((m) => !STABLES.has(m.symbol));
    const totalInUsd = nonStableIns.reduce((s, m) => s + (m.usd ?? 0), 0);
    for (const m of nonStableIns) {
      const share = totalInUsd > 0 ? (m.usd ?? 0) / totalInUsd : 1 / nonStableIns.length;
      pool(canon(m.symbol)).buy(m.amount, cost * share, op.time, `куплено за ${outs.map((o) => `${f(o.amount, 2)} ${o.symbol}`).join("+")}`);
    }
    continue;
  }

  // ── rewards / fiat: market price at the op hour ──
  if (op.type === "claim_rewards" || op.type === "deposit_fiat") {
    for (const m of mv) {
      if (m.direction !== "in" || m.amount <= 0 || isDust(m.symbol, m.amount)) continue;
      const c = canon(m.symbol);
      if (c !== "ETH" && c !== "WBTC") continue;
      const px = histPrice(c as "ETH" | "WBTC", op.time);
      if (px == null) { console.log(`  ⚠ нет hist-цены для ${c} @ ${d(op.time)}`); continue; }
      pool(c).buy(m.amount, m.amount * px, op.time, `${op.type} @ рынок $${f(px, 2)}`);
    }
    continue;
  }

  // ── borrow: если по этому протоколу ранее ВНЕСЕНО ≥ этого количества того же
  //    актива — это вывод залога, мисклассифицированный как borrow (Morpho
  //    withdrawCollateral): актив возвращается со своей исходной базой.
  //    Иначе настоящий займ волатильного актива → рынок на момент займа.
  if (op.type === "borrow") {
    for (const m of mv) {
      if (m.direction !== "in" || m.amount <= 0 || isDust(m.symbol, m.amount)) continue;
      const c = canon(m.symbol);
      if (c !== "ETH" && c !== "WBTC") continue;
      const held = pool(`held:${proto}:${c}`);
      if (held.qty >= m.amount - 1e-9) {
        const cost = held.consume(m.amount, op.time, "возврат залога (op мисклассифицирован как borrow)");
        pool(c).buy(m.amount, cost, op.time, `возврат залога из ${proto} (база сохранена)`);
        continue;
      }
      const px = histPrice(c as "ETH" | "WBTC", op.time);
      if (px == null) { console.log(`  ⚠ нет hist-цены (borrow) ${c} @ ${d(op.time)}`); continue; }
      pool(c).buy(m.amount, m.amount * px, op.time, `borrow @ рынок $${f(px, 2)} (⚠ суб-решение)`);
    }
    continue;
  }

  // ── lend_supply / lend_withdraw / lp_add(non-GMX) / прочее: generic consume/return ──
  for (const m of mv) {
    if (m.amount <= 0 || isDust(m.symbol, m.amount)) continue;
    const c = canon(m.symbol);
    if (m.direction === "out" && (c === "ETH" || c === "WBTC")) {
      const cost = pool(c).consume(m.amount, op.time, `${op.type} ${proto}`);
      if (proto === "arb_fluid" && op.type === "lend_supply") fluidSupplies.push({ time: op.time, sym: c, amount: m.amount, cost });
      else if (c === "ETH" || c === "WBTC") {
        // деталь: депозит в Aave/Morpho/V3 — стоимость уезжает в ту позицию;
        // вернётся при lend_withdraw тем же количеством (см. ниже)
        pool(`held:${proto}:${c}`).buy(m.amount, cost, op.time, "");
      }
    }
    if (m.direction === "in" && (c === "ETH" || c === "WBTC") && op.type === "lend_withdraw") {
      const held = pool(`held:${proto}:${c}`);
      const cost = held.qty > 0 ? held.consume(Math.min(m.amount, held.qty), op.time, "возврат из протокола") : (histPrice(c as any, op.time) ?? 0) * m.amount;
      pool(c).buy(m.amount, cost, op.time, `возврат из ${proto}`);
    }
  }
}

console.log("\n══════════ GM-РЫНКИ (последовательная WAC per-token) ══════════");
for (const [mkt, lines] of gmLogs) {
  const p = pools.get(`GM:${mkt.slice(0, 6)}`);
  console.log(`\n── ${mkt.slice(0, 8)} ──`);
  for (const l of lines) console.log("  " + l);
  if (p) console.log(`  ИТОГ: qty=${f(p.qty, 6)} GM, basis=$${f(p.basis, 2)}, WAC=$${p.wac().toFixed(6)}`);
}

console.log("\n══════════ ЗАВОДЫ ВО FLUID (унаследованная стоимость) ══════════");
let fluidEth = 0, fluidWbtc = 0, fluidEthAmt = 0, fluidWbtcAmt = 0;
for (const s of fluidSupplies) {
  console.log(`  ${d(s.time)}  ${f(s.amount, 8)} ${s.sym}  → стоимость $${f(s.cost, 2)}  ($${f(s.cost / s.amount, 2)}/${s.sym})`);
  if (s.sym === "ETH") { fluidEth += s.cost; fluidEthAmt += s.amount; }
  else { fluidWbtc += s.cost; fluidWbtcAmt += s.amount; }
}
console.log(`\n  FLUID ETH:  Внесено ${f(fluidEthAmt, 6)} ETH, Стартовая $ = $${f(fluidEth, 2)}`);
console.log(`  FLUID WBTC: Внесено ${f(fluidWbtcAmt, 8)} WBTC, Стартовая $ = $${f(fluidWbtc, 2)}`);
console.log(`\n  Сервер сейчас:`);
for (const [k, v] of serverByLp) console.log(`   ${k} → $${f(v.startUsd, 2)}`);

await db.pool.end();
process.exit(0);
