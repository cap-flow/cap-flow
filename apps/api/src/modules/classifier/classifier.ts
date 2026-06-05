/**
 * EVM chain classifier — server port of
 * `apps/web/src/lib/portfolio/classifier.ts` (P5.3).
 *
 * Pure function: takes raw DeBank history items + context, returns
 * `ClassifiedOp[]` with financial categories (deposit_fiat / swap /
 * lend_supply / borrow / lp_add / …). Junk-detection runs as a second
 * pass, tags are appended to `op.notes`.
 *
 * Sorting: input is "newest → oldest" (DeBank order); output is
 * "oldest → newest" so the cost-basis reducer can move forward in time.
 */

import { classifyJunk } from "./junk_filter.js";
import {
  classifyProtocol,
  isLendingReceipt,
  isProtocolToken,
  isStableSymbol,
} from "./protocols.js";
import { isDebtReceiptOfProtocol, isReceiptOfProtocol } from "./token_roles.js";
import type {
  DeBankHistoryItem,
  DeBankProject,
  DeBankToken,
} from "./debank_types.js";
import type { ClassifiedOp, OpType, TokenMovement } from "./types.js";
import { classifyByTopic0, type Topic0Log } from "@cap-flow/ucb/topic0_dict";

export interface ClassifyContext {
  readonly ownAddresses: Set<string>;
  readonly selfAddress: string;
  readonly tokens: Record<string, DeBankToken>;
  readonly projects: Record<string, DeBankProject>;
  readonly cex: Record<string, { id: string; name: string }>;
  /**
   * Топик0-лестница (PRIMARY): логи tx по хэшу (lowercase) для событийной
   * классификации (`classifyByTopic0`). Заполняется log-fetch enrichment'ом
   * (отдельный шаг, за рубильником). Когда не задан / нет логов для tx —
   * классификатор работает как раньше (топик0 — no-op, ноль регресса).
   */
  readonly logsByTxHash?: ReadonlyMap<string, readonly Topic0Log[]>;
}

export function classifyHistory(
  raw: DeBankHistoryItem[],
  ctx: ClassifyContext
): ClassifiedOp[] {
  const seen = new Set<string>();
  const unique: DeBankHistoryItem[] = [];
  for (const it of raw) {
    const k = `${it.chain}:${it.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(it);
  }
  unique.sort((a, b) => a.time_at - b.time_at);

  const classified = unique.map((it, i) => classifyOne(it, i + 1, ctx));
  for (const op of classified) {
    try {
      const junkTags = classifyJunk(op);
      if (junkTags.length > 0) {
        op.notes = [...(op.notes ?? []), ...junkTags];
      }
    } catch (e) {
      // Junk-detection failure must not break the whole history.
      // eslint-disable-next-line no-console
      console.warn(
        `[junk_filter] failed for op ${op.hash.slice(0, 10)}:`,
        (e as Error).message
      );
    }
  }
  return classified;
}

// P2: fnName'ы allowance-ops, которые DeBank иногда отдаёт БЕЗ cate_id='approve'
// и token_approve (→ падали в unknown). При пустом movement классифицируем по
// fnName в `approve`. Всё прочее value-less с пустым movement → `noise`.
const APPROVE_FNS = new Set([
  "approve",
  "approveforall",
  "setapprovalforall",
  "increaseallowance",
]);

function classifyOne(
  it: DeBankHistoryItem,
  seq: number,
  ctx: ClassifyContext
): ClassifiedOp {
  const r = doClassify(it, seq, ctx);
  if (it.tx?.from_addr && it.tx?.to_addr) {
    const from = it.tx.from_addr.toLowerCase();
    const to = it.tx.to_addr.toLowerCase();
    r.counterparty = from === ctx.selfAddress ? it.tx.to_addr : it.tx.from_addr;
    if (from !== ctx.selfAddress && to !== ctx.selfAddress) {
      r.counterparty = it.tx.to_addr;
    }
  }
  return r;
}

function doClassify(
  it: DeBankHistoryItem,
  seq: number,
  ctx: ClassifyContext
): ClassifiedOp {
  const movement = buildMovements(it, ctx);
  const project = (it.project_id && ctx.projects[it.project_id]) || null;
  const protocol = classifyProtocol(it.project_id, project?.name ?? null);

  const status: "ok" | "failed" = it.tx?.status === 0 ? "failed" : "ok";

  if (status === "failed") {
    return base(it, seq, "failed", protocol, movement, status);
  }

  // ── Ступень 1: topic0 (PRIMARY) — событийная классификация по логам tx ──
  // Авторитетнее DeBank-эвристик и имён методов (роутеры execute/multicall
  // бессмысленны по fnName). Срабатывает ТОЛЬКО когда логи для tx переданы
  // (log-fetch enrichment, за рубильником) И classifyByTopic0 уверен. Иначе —
  // проваливаемся в существующую лестницу (сеть безопасности; ноль регресса).
  // DATA-decode семейства (GMX/Fluid/V4) classifyByTopic0 НЕ гадает (→ null) —
  // их декодеры вживляются отдельным шагом.
  const txLogs = it.id ? ctx.logsByTxHash?.get(it.id.toLowerCase()) : undefined;
  if (txLogs && txLogs.length > 0) {
    const t0 = classifyByTopic0(txLogs, {
      protocolCategory: protocol?.category ?? null,
    });
    if (t0) {
      return base(it, seq, t0.opType, protocol, movement, status, [
        `topic0:${t0.event}`,
      ]);
    }
  }

  const hasRealOut = movement.some(
    (m) => m.direction === "out" && m.amount > 1e-6
  );
  const hasRealIn = movement.some(
    (m) => m.direction === "in" && m.amount > 1e-6
  );
  const hasMeaningfulMovement = movement.some(
    (m) => m.amount > 1e-6 && (m.usd ?? 0) > 1
  );
  if (
    (it.cate_id === "approve" || it.token_approve) &&
    !(hasRealOut && hasRealIn) &&
    !hasMeaningfulMovement
  ) {
    return base(it, seq, "approve", protocol, movement, status);
  }

  const sends = movement.filter((m) => m.direction === "out");
  const receives = movement.filter((m) => m.direction === "in");

  // 2. CEX deposit/withdraw.
  if (it.cex_id && ctx.cex[it.cex_id]) {
    const cex = ctx.cex[it.cex_id]!;
    if (sends.length === 0 && receives.length > 0) {
      return base(it, seq, "deposit_fiat", protocol, movement, status, [
        `from CEX: ${cex.name}`,
      ]);
    }
    if (sends.length > 0 && receives.length === 0) {
      return base(it, seq, "withdraw_fiat", protocol, movement, status, [
        `to CEX: ${cex.name}`,
      ]);
    }
  }

  // 3. Internal transfer between own wallets.
  const from = it.tx?.from_addr?.toLowerCase();
  const to = it.tx?.to_addr?.toLowerCase();
  const ownsFrom = from && ctx.ownAddresses.has(from);
  const ownsTo = to && ctx.ownAddresses.has(to);
  if (
    ownsFrom &&
    ownsTo &&
    from !== to &&
    !protocol &&
    (sends.length || receives.length)
  ) {
    if (sends.length && !receives.length) {
      return base(it, seq, "transfer_out", protocol, movement, status);
    }
    if (receives.length && !sends.length) {
      return base(it, seq, "transfer_in", protocol, movement, status);
    }
  }

  // 4. Bridge.
  if (protocol?.category === "bridge") {
    if (sends.length && !receives.length) {
      return base(it, seq, "bridge_out", protocol, movement, status);
    }
    if (receives.length && !sends.length) {
      return base(it, seq, "bridge_in", protocol, movement, status);
    }
  }

  // 5. Lending / CDP.
  if (
    protocol &&
    (protocol.category === "lending" || protocol.category === "cdp")
  ) {
    return classifyLending(it, seq, protocol, sends, receives, status, movement);
  }

  // 6. Staking / restaking.
  if (
    protocol &&
    (protocol.category === "staking" || protocol.category === "restaking")
  ) {
    if (receives.some((r) => isProtocolToken(r.symbol))) {
      return base(it, seq, "stake", protocol, movement, status);
    }
    if (sends.some((s) => isProtocolToken(s.symbol))) {
      return base(it, seq, "unstake", protocol, movement, status);
    }
    if (receives.length && !sends.length) {
      return base(it, seq, "claim_rewards", protocol, movement, status);
    }
  }

  // 7. Yield / Perp pool deposits — async-deposit aware semantics.
  if (protocol?.category === "yield" || protocol?.category === "perp") {
    const sentProto = sends.some((s) => s.isProtocolToken);
    const recvProto = receives.some((r) => r.isProtocolToken);

    if (recvProto && !sentProto) {
      return base(it, seq, "lp_add", protocol, movement, status, [
        protocol.category === "perp"
          ? "perp-deposit-fill"
          : "yield-deposit-fill",
      ]);
    }
    if (sentProto && !recvProto) {
      return base(it, seq, "lp_remove", protocol, movement, status);
    }
    if (sends.length && !receives.length) {
      return base(it, seq, "lp_add", protocol, movement, status, [
        protocol.category === "perp" ? "perp-deposit" : "yield-deposit",
      ]);
    }
    if (receives.length && !sends.length) {
      return base(it, seq, "lp_remove", protocol, movement, status);
    }
    if (sends.length && receives.length) {
      // Send + receive в yield/perp могут быть И swap'ом (Pendle PT/SY
      // exchange), И deposit'ом с vault-receipt'ом (Avantis USDC →
      // USDC.f). Heuristic-различить трудно без protocol-specific
      // знания. Оставляем `swap` как default → downstream `buildOpenPositions`
      // делает live-state-aware backfill: если для protocol есть live
      // LP но нет `lp_add` ops, рассматривает swap ops в этом protocol
      // как кандидатов на открывающий event.
      return base(it, seq, "swap", protocol, movement, status);
    }
  }

  // 8. DEX / LP.
  if (protocol && (protocol.category === "dex" || protocol.category === "lp")) {
    return classifyDex(it, seq, protocol, sends, receives, status, movement);
  }

  // 9. Plain swap without recognized project (aggregators / direct routers).
  // EXCEPTION: a protocol DEPOSIT RECEIPT (LP position NFT / lending aToken) is
  // never the OUTPUT of a swap — receiving one means a deposit/supply. Don't let
  // a single-leg smart-account wrapper deposit short-circuit to `swap`; let it
  // fall through to the receipt branch (section 11). LST/vault tokens
  // (stETH/yv*/moo) are intentionally NOT excluded — those ARE swappable.
  const recvIsDepositReceipt =
    receives.length === 1 &&
    (() => {
      const s = receives[0]!.symbol;
      const isLpNft =
        s === "UNI-V3-POS" ||
        s === "UNI-V4-POS" ||
        /^UNI-V\d-/i.test(s) ||
        /-V3-POS$/i.test(s);
      const isLendReceipt =
        isLendingReceipt(s) && !/^variabledebt|^stabledebt/i.test(s);
      return isLpNft || isLendReceipt;
    })();
  if (
    sends.length === 1 &&
    receives.length === 1 &&
    sends[0]!.tokenId !== receives[0]!.tokenId &&
    !recvIsDepositReceipt
  ) {
    return base(it, seq, "swap", protocol, movement, status);
  }

  // 10. Smart-account / EIP-7702 / delegation / router wrappers
  // (redeemDelegations, execute, multicall) carry no project_id and an opaque
  // outer fnName; sub-$1 gas/approval dust can ride alongside the real action.
  // Classify by MATERIAL (≥$1) movement so dust doesn't mask a fee-collect or
  // supply. Зеркалит web-classifier (apps/web/src/lib/portfolio/classifier.ts).
  const DUST_USD = 1;
  const matSends = sends.filter((s) => (s.usd ?? 0) >= DUST_USD);
  const matReceives = receives.filter((r) => (r.usd ?? 0) >= DUST_USD);
  const fnName = (it.tx?.name ?? "").toLowerCase();
  const isDelegationFn =
    fnName === "redeemdelegations" || fnName.includes("delegation");

  // 10.1 Plain transfer_out (only sends, nothing received).
  if (sends.length && !receives.length) {
    return base(it, seq, "transfer_out", protocol, movement, status);
  }

  // 10.2 Delegation fee-collect: V3 fee collect через smart-account. 2+
  // МАТЕРИАЛЬНЫХ IN (stable + volatile), без материального OUT (dust gas-refund
  // терпим). Без правила → transfer_in/unknown и пропуск в Fee lifetime для
  // V3 LP позиций (bob POS-009 18.03.2026; mmaksimuk redeemDelegations ×3).
  if (isDelegationFn && matSends.length === 0 && matReceives.length >= 2) {
    const hasVolatile = matReceives.some(
      (r) => !r.isStable && !r.isProtocolToken
    );
    const hasStable = matReceives.some((r) => r.isStable);
    if (hasVolatile && hasStable) {
      const inferredProtocol = {
        id: `${it.chain}_uniswap3`,
        name: "Uniswap V3",
        category: "dex" as const,
      };
      return base(it, seq, "claim_rewards", inferredProtocol, movement, status, [
        "delegation-collect",
      ]);
    }
  }

  // 11. Protocol-token receipt без project_id. Wrappers strip project_id;
  // полученный receipt-токен сам идентифицирует протокол и действие
  // (IN receipt + OUT underlying).
  const protoReceipt = receives.find((r) => r.isProtocolToken);
  if (protoReceipt && sends.length > 0) {
    const sym = protoReceipt.symbol;
    // 11a. Uniswap V3/V4 position NFT → lp_add (delegation-mint).
    if (
      sym === "UNI-V3-POS" ||
      sym === "UNI-V4-POS" ||
      /^UNI-V\d-/i.test(sym) ||
      /-V3-POS$/i.test(sym)
    ) {
      const isV4 = sym.toLowerCase().includes("v4");
      const inferredProtocol = {
        id: `${it.chain}_${isV4 ? "uniswap4" : "uniswap3"}`,
        name: isV4 ? "Uniswap V4" : "Uniswap V3",
        category: "dex" as const,
      };
      return base(it, seq, "lp_add", inferredProtocol, movement, status, [
        "delegation-mint",
      ]);
    }
    // 11b. Aave-style lending receipt (aToken) → lend_supply. Debt receipts
    // (variableDebt/stableDebt) исключаем — это borrow, не supply.
    if (isLendingReceipt(sym) && !/^variabledebt|^stabledebt/i.test(sym)) {
      const inferredProtocol = {
        id: `${it.chain}_aave3`,
        name: "Aave V3",
        category: "lending" as const,
      };
      return base(it, seq, "lend_supply", inferredProtocol, movement, status, [
        "delegation-supply",
      ]);
    }
  }

  // 12. Plain transfer_in (only receives, nothing identified above).
  if (receives.length && !sends.length) {
    return base(it, seq, "transfer_in", protocol, movement, status);
  }

  // 12.5 Value-bearing multi-token ops on protocols the catalog does NOT name
  // (category "other" / null) — they reach here unclassified. Two strong signals:
  //   • named bridge (deBridge/Stargate/Across/…) → bridge_out/in by net flow;
  //   • an LP position / vault / pool-share receipt token on exactly one side
  //     (RAMSES RAM-V2-POS, ICHI IV-* vault, Balancer-style BPT "a/b/c"), or an
  //     explicit exit/join fnName → lp_remove (receipt out / exit) / lp_add
  //     (receipt in / join). These receipt tokens only move when adding/removing
  //     liquidity, so the signal is reliable. Runs AFTER all category handlers +
  //     plain-swap (section 9), so recognized protocols & 1-in-1-out swaps are
  //     untouched; only multi-token ops on unnamed protocols land here.
  if (sends.length > 0 && receives.length > 0) {
    const fnName = (it.tx?.name ?? "").toLowerCase();
    const pname = `${protocol?.id ?? ""} ${protocol?.name ?? ""}`.toLowerCase();
    if (/debridge|stargate|across|\bhop\b|celer|synapse|wormhole|layerzero|orbiter|squid/.test(pname)) {
      const outUsd = sends.reduce((s, m) => s + (m.usd ?? 0), 0);
      const inUsd = receives.reduce((s, m) => s + (m.usd ?? 0), 0);
      return base(it, seq, outUsd >= inUsd ? "bridge_out" : "bridge_in", protocol, movement, status, [
        "heuristic-bridge",
      ]);
    }
    const isLpReceipt = (sym: string) =>
      /-V\d+-POS$/i.test(sym) || /^IV-/i.test(sym) || sym.includes("/");
    const sentReceipt = sends.some((m) => isLpReceipt(m.symbol));
    const recvReceipt = receives.some((m) => isLpReceipt(m.symbol));
    const exitFn =
      fnName === "exitpool" || fnName === "redeem" || fnName === "removeliquidity";
    const joinFn = fnName === "joinpool" || fnName === "addliquidity";
    if (exitFn || (sentReceipt && !recvReceipt)) {
      return base(it, seq, "lp_remove", protocol, movement, status, ["heuristic-lp"]);
    }
    if (joinFn || (recvReceipt && !sentReceipt)) {
      return base(it, seq, "lp_add", protocol, movement, status, ["heuristic-lp"]);
    }
  }

  // 13. P2 empty-movement value-less fallback (non-dex / null / other / perp
  // projects: spam/zero-value transfer, points, referral, multicall, EIP-7702,
  // approveForAll on non-dex). No token moved → route out of `unknown`:
  // approve-family fnNames → `approve`, everything else → `noise`. classifyJunk
  // still tags junk:empty_movement so isJunkOp keeps these inert. The final
  // `unknown` below is now reachable ONLY for VALUE-BEARING unmatched ops.
  if (sends.length === 0 && receives.length === 0) {
    const fnName = (it.tx?.name ?? "").toLowerCase();
    if (APPROVE_FNS.has(fnName)) {
      return base(it, seq, "approve", protocol, movement, status);
    }
    return base(it, seq, "noise", protocol, movement, status);
  }

  return base(it, seq, "unknown", protocol, movement, status);
}

function classifyLending(
  it: DeBankHistoryItem,
  seq: number,
  protocol: ReturnType<typeof classifyProtocol>,
  sends: TokenMovement[],
  receives: TokenMovement[],
  status: "ok" | "failed",
  movement: TokenMovement[]
): ClassifiedOp {
  const protoId = protocol?.id ?? "";
  const sentDebt = sends.some((s) =>
    isDebtReceiptOfProtocol(s.symbol, protoId)
  );
  const recvDebt = receives.some((r) =>
    isDebtReceiptOfProtocol(r.symbol, protoId)
  );
  const isSupplyReceipt = (sym: string): boolean =>
    isReceiptOfProtocol(sym, protoId) &&
    !isDebtReceiptOfProtocol(sym, protoId);
  const sentSupply = sends.some((s) => isSupplyReceipt(s.symbol));
  const recvSupply = receives.some((r) => isSupplyReceipt(r.symbol));

  if (recvDebt && !sentDebt) {
    return base(it, seq, "borrow", protocol, movement, status);
  }
  if (sentDebt && !recvDebt) {
    return base(it, seq, "repay", protocol, movement, status);
  }
  if (!sentSupply && recvSupply) {
    const sentSyms = new Set(sends.map((s) => s.symbol.toUpperCase()));
    const hasBorrowComponent = receives.some(
      (r) =>
        !isSupplyReceipt(r.symbol) &&
        !isDebtReceiptOfProtocol(r.symbol, protoId) &&
        !sentSyms.has(r.symbol.toUpperCase()) &&
        r.amount > 0
    );
    return base(
      it,
      seq,
      "lend_supply",
      protocol,
      movement,
      status,
      hasBorrowComponent ? ["combined-supply-borrow"] : []
    );
  }
  if (sentSupply && !recvSupply) {
    const recvSyms = new Set(receives.map((r) => r.symbol.toUpperCase()));
    const hasRepayComponent = sends.some(
      (s) =>
        !isSupplyReceipt(s.symbol) &&
        !isDebtReceiptOfProtocol(s.symbol, protoId) &&
        !recvSyms.has(s.symbol.toUpperCase()) &&
        s.amount > 0
    );
    return base(
      it,
      seq,
      "lend_withdraw",
      protocol,
      movement,
      status,
      hasRepayComponent ? ["combined-withdraw-repay"] : []
    );
  }

  // Receipt-less protocols (Morpho Blue, …): no receipt in wallet, use
  // direction + asset-type heuristics on underlyings.
  if (!sends.length && receives.length) {
    return base(it, seq, "borrow", protocol, movement, status);
  }
  if (sends.length && !receives.length) {
    const allStables = sends.every((s) => s.isStable);
    if (allStables) {
      return base(it, seq, "repay", protocol, movement, status);
    }
    return base(it, seq, "lend_supply", protocol, movement, status);
  }
  if (sends.length && receives.length) {
    return base(it, seq, "lend_supply", protocol, movement, status, [
      "compound-supply-borrow",
    ]);
  }
  return base(it, seq, "lend_supply", protocol, movement, status, [
    "ambiguous-lending",
  ]);
}

function classifyDex(
  it: DeBankHistoryItem,
  seq: number,
  protocol: ReturnType<typeof classifyProtocol>,
  sends: TokenMovement[],
  receives: TokenMovement[],
  status: "ok" | "failed",
  movement: TokenMovement[]
): ClassifiedOp {
  const sendsLp = sends.some((s) => s.isProtocolToken);
  const recvLp = receives.some((r) => r.isProtocolToken);

  // Gauge unstake (Velodrome/Aerodrome CL Slipstream): `CLGauge.withdraw(tokenId)`
  // возвращает позиционный NFT из gauge в кошелёк — protocol-token IN, при этом
  // НИЧЕГО не уходит. Это РАССТЕЙК, не внесение ликвидности. Без этого guard'а
  // ветка `recvLp && !sendsLp` ниже метит его `lp_add` → ложный opener с датой
  // анстейка и нулевым cost basis (POS-011). Реальный mint имеет sends
  // (underlying) → сюда не попадает.
  // ВАЖНО: тот же fix есть в клиентском apps/web/src/lib/portfolio/classifier.ts
  // (параллельный pipeline — refresh классифицирует на клиенте и пушит через
  // POST /chain-ops/:walletId/sync — менять синхронно).
  const fnName = (it.tx?.name ?? "").toLowerCase();
  if (recvLp && !sendsLp && sends.length === 0 && fnName.includes("withdraw")) {
    return base(it, seq, "unstake", protocol, movement, status, [
      "gauge-unstake",
    ]);
  }

  if (recvLp && !sendsLp) {
    return base(it, seq, "lp_add", protocol, movement, status);
  }
  if (sendsLp && !recvLp) {
    return base(it, seq, "lp_remove", protocol, movement, status);
  }
  if (sends.length && receives.length) {
    return base(it, seq, "swap", protocol, movement, status);
  }
  if (sends.length && !receives.length) {
    return base(it, seq, "lp_add", protocol, movement, status, [
      "v3-increase-liquidity",
    ]);
  }
  if (receives.length && !sends.length) {
    // V3 receives-only: default to claim_rewards (collect fees). Skipping a
    // fee-claim is worse than mis-labeling a withdraw; closed positions
    // disappear from live state regardless.
    return base(it, seq, "claim_rewards", protocol, movement, status, [
      "v3-collect-fees",
    ]);
  }
  // P1: NPM collect() with EMPTY movement. DeBank sometimes returns no token
  // amounts for a fee collect (zero-fee collect, or a movement gap). Both
  // sends and receives are empty here, so the branches above can't fire and it
  // would fall to `unknown`. A `collect` on a DEX — or any direct call to the
  // Uniswap V3 NonfungiblePositionManager — is a fee claim. Numerically inert:
  // empty movement → $0; classifyJunk still tags junk:empty_movement so
  // isJunkOp keeps it out of the fee engine; Krystal owns the real fee value.
  // We chain-prefix protocol.id (eth rows arrive as bare "uniswap3") so the
  // op matches its live LP position downstream — generically, so a Velodrome/
  // Aerodrome collect keeps its own protocol id rather than being forced to uniswap.
  if (protocol && sends.length === 0 && receives.length === 0) {
    const fnName = (it.tx?.name ?? "").toLowerCase();
    const NPM = "0xc36442b4a4522e871399cd717abdd847ab11fe88";
    const toNpm = (it.tx?.to_addr ?? "").toLowerCase() === NPM;
    if (fnName === "collect" || toNpm) {
      const cp = protocol.id.startsWith(`${it.chain}_`)
        ? protocol
        : { id: `${it.chain}_${protocol.id}`, name: protocol.name, category: protocol.category };
      return base(it, seq, "claim_rewards", cp, movement, status, [
        "v3-collect-fees",
        "needs_backfill",
      ]);
    }
    // P2: value-less empty-movement op on a DEX project (approve/setApprovalForAll
    // on Aerodrome/Uniswap V4, или прочий state-only вызов). Route out of `unknown`.
    if (APPROVE_FNS.has(fnName)) {
      return base(it, seq, "approve", protocol, movement, status);
    }
    return base(it, seq, "noise", protocol, movement, status);
  }
  return base(it, seq, "unknown", protocol, movement, status);
}

function buildMovements(
  it: DeBankHistoryItem,
  ctx: ClassifyContext
): TokenMovement[] {
  const move: TokenMovement[] = [];
  for (const s of it.sends) {
    move.push(toMovement("out", s.token_id, s.amount, ctx.tokens));
  }
  for (const r of it.receives) {
    move.push(toMovement("in", r.token_id, r.amount, ctx.tokens));
  }
  return move;
}

function toMovement(
  direction: "in" | "out",
  tokenId: string,
  amount: number,
  tokens: Record<string, DeBankToken>
): TokenMovement {
  const t = tokens[tokenId];
  const symbol = t?.symbol ?? tokenId.slice(0, 6).toUpperCase();
  const usd = t?.price ? t.price * amount : null;
  return {
    direction,
    symbol,
    tokenId,
    amount,
    usd,
    isStable: isStableSymbol(symbol),
    isProtocolToken: isProtocolToken(symbol),
  };
}

function base(
  it: DeBankHistoryItem,
  seq: number,
  type: OpType,
  protocol: ReturnType<typeof classifyProtocol>,
  movement: TokenMovement[],
  status: "ok" | "failed",
  notes?: string[]
): ClassifiedOp {
  const netUsd =
    movement
      .filter((m) => m.direction === "in")
      .reduce((s, m) => s + (m.usd ?? 0), 0) -
    movement
      .filter((m) => m.direction === "out")
      .reduce((s, m) => s + (m.usd ?? 0), 0);
  const fromLc = it.tx?.from_addr?.toLowerCase();
  const counterparty =
    it.tx?.from_addr && it.tx?.to_addr
      ? fromLc && it.tx.from_addr.toLowerCase() === fromLc
        ? it.tx.to_addr
        : it.tx.from_addr
      : null;

  const op: ClassifiedOp = {
    seq,
    hash: it.id,
    chain: it.chain,
    time: it.time_at,
    status,
    type,
    protocol,
    movement,
    netUsd,
    gasUsd: it.tx?.usd_gas_fee ?? null,
    counterparty,
    feePayer: it.tx?.from_addr ?? null,
    fnName: it.tx?.name ?? null,
    approveSpender: it.token_approve?.spender ?? null,
    approveSymbol: it.token_approve
      ? toMovement("out", it.token_approve.token_id, 0, {}).symbol
      : null,
  };
  if (notes && notes.length) op.notes = notes;
  return op;
}
