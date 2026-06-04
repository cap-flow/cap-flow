import type {
  DeBankHistoryItem,
  DeBankProject,
  DeBankToken,
} from "../debank";
import {
  classifyProtocol,
  isLendingReceipt,
  isProtocolToken,
  isStableSymbol,
} from "./protocols";
import { classifyJunk } from "./junk_filter";
import { isDebtReceiptOfProtocol, isReceiptOfProtocol } from "./token_roles";
import type { ClassifiedOp, OpType, TokenMovement } from "./types";

interface ClassifyContext {
  /** Все адреса, известные пользователю (его кошельки в lower-case). */
  ownAddresses: Set<string>;
  /** Текущий рассматриваемый кошелёк в lower-case. */
  selfAddress: string;
  /** Словари из DeBank-ответа. */
  tokens: Record<string, DeBankToken>;
  projects: Record<string, DeBankProject>;
  cex: Record<string, { id: string; name: string }>;
}

/**
 * Главная функция: берёт сырую историю DeBank + контекст и возвращает
 * массив операций с финансовой классификацией.
 *
 * Сортировка: на входе предполагается порядок «новые → старые» (DeBank так отдаёт),
 * на выходе — порядок «старые → новые», чтобы reducer мог идти по времени вперёд.
 */
export function classifyHistory(
  raw: DeBankHistoryItem[],
  ctx: ClassifyContext,
): ClassifiedOp[] {
  // Уникализируем и сортируем по времени по возрастанию.
  const seen = new Set<string>();
  const unique: DeBankHistoryItem[] = [];
  for (const it of raw) {
    const k = `${it.chain}:${it.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(it);
  }
  unique.sort((a, b) => a.time_at - b.time_at);

  // Сначала базовая классификация, потом проход junk-detection'а.
  // Junk-теги добавляются в `op.notes` чтобы analytics/UI могли фильтровать.
  // Junk-детект обёрнут в try/catch — никакой edge-case не должен ломать
  // классификацию всей истории.
  const classified = unique.map((it, i) => classifyOne(it, i + 1, ctx));
  for (const op of classified) {
    try {
      const junkTags = classifyJunk(op);
      if (junkTags.length > 0) {
        op.notes = [...(op.notes ?? []), ...junkTags];
      }
    } catch (e) {
      console.warn(
        `[junk_filter] failed for op ${op.hash.slice(0, 10)}:`,
        (e as Error).message,
      );
    }
  }
  return classified;
}

// P2: fnName'ы allowance-ops, которые DeBank иногда отдаёт БЕЗ cate_id='approve'
// и token_approve (→ падали в unknown). При пустом movement → `approve`. Прочее
// value-less с пустым movement → `noise`. Зеркало server-classifier.
const APPROVE_FNS = new Set([
  "approve",
  "approveforall",
  "setapprovalforall",
  "increaseallowance",
]);

function classifyOne(
  it: DeBankHistoryItem,
  seq: number,
  ctx: ClassifyContext,
): ClassifiedOp {
  // Локальный override базовой функции — чтобы counterparty считался относительно selfAddress.
  const _result = (): ClassifiedOp => doClassify(it, seq, ctx);
  const r = _result();
  // Уточняем counterparty с учётом ctx.selfAddress
  if (it.tx?.from_addr && it.tx?.to_addr) {
    const from = it.tx.from_addr.toLowerCase();
    const to = it.tx.to_addr.toLowerCase();
    r.counterparty = from === ctx.selfAddress ? it.tx.to_addr : it.tx.from_addr;
    if (from !== ctx.selfAddress && to !== ctx.selfAddress) {
      // ни from ни to не совпадает — пользователь, возможно, был в logs, не в tx
      r.counterparty = it.tx.to_addr;
    }
  }
  return r;
}

function doClassify(
  it: DeBankHistoryItem,
  seq: number,
  ctx: ClassifyContext,
): ClassifiedOp {
  const movement = buildMovements(it, ctx);
  const project =
    (it.project_id && ctx.projects[it.project_id]) ||
    null;
  const protocol = classifyProtocol(
    it.project_id,
    project?.name ?? null,
  );

  const status: "ok" | "failed" = it.tx?.status === 0 ? "failed" : "ok";

  // Для не-success — спецтип, чтобы reducer пропустил эффекты.
  if (status === "failed") {
    return base(it, seq, "failed", protocol, movement, status);
  }

  // 1. Approve — только когда РЕАЛЬНЫХ движений нет.
  //    DeBank иногда помечает свопы на 1inch / KyberSwap / Uniswap V4 как
  //    `approve`, потому что роутер вызывается через permit/approve-функцию;
  //    но если в movement есть реальные in/out — это не approve, а свап.
  //    Также не approve: GMX V2 / GMSOL withdraw — DeBank ставит
  //    `cate_id="approve"`, потому что multicall включает approve-шаг,
  //    но реально пользователь отправляет protocol-token (GM/GLV) на сжигание.
  //    Считаем approve, ТОЛЬКО если нет ни одного значимого movement —
  //    либо нет ничего, либо только pure-approve-поле без amount-движений.
  const hasRealOut = movement.some(
    (m) => m.direction === "out" && m.amount > 1e-6,
  );
  const hasRealIn = movement.some(
    (m) => m.direction === "in" && m.amount > 1e-6,
  );
  const hasMeaningfulMovement = movement.some(
    (m) => m.amount > 1e-6 && (m.usd ?? 0) > 1, // > $1 = не gas-only
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

  // 2. CEX-движение.
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

  // 3. Трансфер между своими кошельками.
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

  // 4. Bridge — есть протокол-мост.
  if (protocol?.category === "bridge") {
    if (sends.length && !receives.length) {
      return base(it, seq, "bridge_out", protocol, movement, status);
    }
    if (receives.length && !sends.length) {
      return base(it, seq, "bridge_in", protocol, movement, status);
    }
  }

  // 5. Lending / CDP.
  if (protocol && (protocol.category === "lending" || protocol.category === "cdp")) {
    return classifyLending(it, seq, protocol, sends, receives, status, movement);
  }

  // 6. Staking / restaking.
  if (protocol && (protocol.category === "staking" || protocol.category === "restaking")) {
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

  // 7. Yield / Perp — депозит в пул работает как LP (с taint-наследованием).
  //
  // Async-deposit модели (GMX V2 на Arbitrum, GMSOL на Solana, Flash Trade,
  // Adrena и т.д.) исполняются в ДВУХ атомарных транзакциях:
  //   Tx A: пользователь шлёт underlying (USDC/ETH) — sends only
  //   Tx B: keeper выдаёт LP-receipt (GM/GLP/GLV) — receives only
  // Если смотреть только на направление, Tx B помечается lp_remove, что
  // ломает учёт (двойной счёт PnL: USDC ушёл → −$5000, GM пришёл по
  // рыночной цене → +$5376, разница «$376 прибыли» материализуется из воздуха).
  //
  // Правильная семантика — по тому, в какую сторону движется PROTOCOL-TOKEN:
  //   - protocol-token приходит → это часть депозита (lp_add continuation)
  //   - protocol-token уходит → это часть вывода (lp_remove continuation)
  //   - не-protocol → решаем по направлению (start of deposit/withdraw)
  if (protocol?.category === "yield" || protocol?.category === "perp") {
    const sentProto = sends.some((s) => s.isProtocolToken);
    const recvProto = receives.some((r) => r.isProtocolToken);

    if (recvProto && !sentProto) {
      // Tx B депозита: protocol-token пришёл (GM/GLP/GLV).
      // Это завершение lp_add. Cost basis возьмётся из m.usd движения,
      // что даёт рыночную цену GM. TODO: линковать с парной Tx A, чтобы
      // cost basis = USDC_paid (а не market price GM).
      return base(it, seq, "lp_add", protocol, movement, status, [
        protocol.category === "perp" ? "perp-deposit-fill" : "yield-deposit-fill",
      ]);
    }
    if (sentProto && !recvProto) {
      // Tx B вывода: protocol-token ушёл (GM/GLP/GLV).
      return base(it, seq, "lp_remove", protocol, movement, status);
    }

    if (sends.length && !receives.length) {
      // Tx A депозита: underlying ушёл, protocol-токена ещё нет.
      return base(it, seq, "lp_add", protocol, movement, status, [
        protocol.category === "perp" ? "perp-deposit" : "yield-deposit",
      ]);
    }
    if (receives.length && !sends.length) {
      // Tx A вывода: underlying пришёл, protocol-токен уже забрали ранее.
      return base(it, seq, "lp_remove", protocol, movement, status);
    }
    // Своп токенов внутри протокола (например, USDC↔GLP) — обмен.
    if (sends.length && receives.length) {
      return base(it, seq, "swap", protocol, movement, status);
    }
  }

  // 8. DEX / LP.
  if (protocol && (protocol.category === "dex" || protocol.category === "lp")) {
    return classifyDex(it, seq, protocol, sends, receives, status, movement);
  }

  // 9. Чистый swap без распознанного project (агрегаторы / прямые роутеры).
  // ИСКЛЮЧЕНИЕ: protocol DEPOSIT RECEIPT (LP-NFT / lending aToken) никогда не
  // является ВЫХОДОМ свопа — его получение означает deposit/supply. Одноногая
  // smart-account wrapper-операция не должна короткозамыкаться в `swap` —
  // пропускаем в receipt-бранч (секция 11). LST/vault (stETH/yv*/moo) НЕ
  // исключаем — они свопаемы. Зеркало server-classifier.
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
  // Classify by МАТЕРИАЛЬНОМУ (≥$1) movement so dust doesn't mask a fee-collect
  // or supply. Зеркало server-classifier (apps/api/.../classifier.ts).
  const DUST_USD = 1;
  const matSends = sends.filter((s) => (s.usd ?? 0) >= DUST_USD);
  const matReceives = receives.filter((r) => (r.usd ?? 0) >= DUST_USD);
  const fnName = (it.tx?.name ?? "").toLowerCase();
  const isDelegationFn =
    fnName === "redeemdelegations" || fnName.includes("delegation");

  // 10.1 Plain transfer_out (только sends, ничего не получено).
  if (sends.length && !receives.length) {
    return base(it, seq, "transfer_out", protocol, movement, status);
  }

  // ── 10.2 Delegation-collect: Uniswap V3 fee collect через smart-account
  //         wrapper (`redeemDelegations`). DeBank не возвращает project_id →
  //         rule 8 (DEX) не сработал. Признак: fn === 'redeemDelegations' +
  //         2+ МАТЕРИАЛЬНЫХ IN pair-токенов (USDC+WETH / ARB+WETH …) без
  //         материального OUT (dust gas-refund терпим). Классифицируем как
  //         `claim_rewards` Uniswap V3 + delegation-collect note.
  //
  //         Примеры: bob POS-009 lex 1 arb tx 0xbd228680 18.03.2026 (IN
  //         75.58 USD₮0 + 0.0368 WETH = $155 fee); mmaksimuk redeemDelegations
  //         ×3 с dust-ARB send. Раньше попадал в transfer_in/unknown → не
  //         считался в Fee lifetime.
  if (isDelegationFn && matSends.length === 0 && matReceives.length >= 2) {
    const hasVolatile = matReceives.some(
      (r) => !r.isStable && !r.isProtocolToken,
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

  // 11. Protocol-token receipt без project_id. Smart-account/delegation/router
  // wrappers (`redeemDelegations`/`execute`) не присваивают project_id →
  // правила выше падают, и tx становится `unknown`. Но полученный receipt-токен
  // сам идентифицирует протокол и действие (IN receipt + OUT underlying).
  //
  // Примеры: bob POS-009 (2026-02-08) `redeemDelegations` mint UNI-V3-POS,
  // OUT WETH + USD₮0 → lp_add; mmaksimuk `redeemDelegations` supply ETH,
  // IN aArbWETH → lend_supply. Без правил openedAt=null/cost basis теряется.
  const protoReceipt = receives.find((r) => r.isProtocolToken);
  if (protoReceipt && sends.length > 0) {
    const sym = protoReceipt.symbol;
    // 11a. Uniswap V3/V4 position NFT → lp_add (delegation-mint). chain-prefixed
    // id (`arb_uniswap3`) — как ожидает builder (findFirstOpen сравнивает
    // `op.protocol?.id === lp.protocolId` формата `${chain}_uniswap3`).
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

  // 12. Plain transfer_in (только receives, ничего не опознано выше).
  if (receives.length && !sends.length) {
    return base(it, seq, "transfer_in", protocol, movement, status);
  }

  // 12.5 Value-bearing multi-token ops на протоколах, которых НЕТ в каталоге
  // (category "other" / null). Сигналы: named bridge → bridge_out/in по net-flow;
  // LP/vault/BPT receipt-токен на одной стороне (RAMSES RAM-V2-POS, ICHI IV-*,
  // Balancer-style BPT "a/b/c") или exit/join fnName → lp_remove/lp_add. Идёт
  // ПОСЛЕ всех категорий + plain-swap (section 9), так что распознанные протоколы
  // и 1-в-1 свопы не задеты. Зеркало server-classifier.
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

  // 13. P2 empty-movement value-less fallback (non-dex / null / other / perp:
  // spam/zero-value transfer, points, referral, multicall, EIP-7702,
  // approveForAll на non-dex). Движения нет → out of `unknown`: approve-семья →
  // `approve`, прочее → `noise`. classifyJunk ставит junk:empty_movement →
  // isJunkOp держит инертными. Финальный `unknown` ниже теперь достижим ТОЛЬКО
  // для value-bearing (непустой movement). Зеркало server-classifier.
  if (sends.length === 0 && receives.length === 0) {
    const fnName = (it.tx?.name ?? "").toLowerCase();
    if (APPROVE_FNS.has(fnName)) {
      return base(it, seq, "approve", protocol, movement, status);
    }
    return base(it, seq, "noise", protocol, movement, status);
  }

  return base(it, seq, "unknown", protocol, movement, status);
}

/* ----------------------------- helpers ------------------------------------ */

function classifyLending(
  it: DeBankHistoryItem,
  seq: number,
  protocol: ReturnType<typeof classifyProtocol>,
  sends: TokenMovement[],
  receives: TokenMovement[],
  status: "ok" | "failed",
  movement: TokenMovement[],
): ClassifiedOp {
  // Aave/Compound/Fluid выдают aToken/cToken/fVLT при supply. Morpho Blue —
  // receipt-less протокол (нет токена в кошельке).
  // Стандартные паттерны:
  //   supply  : send underlying  → receive receipt (aToken/fVLT)
  //   withdraw: send receipt      → receive underlying
  //   borrow  : (нет send)        → receive underlying
  //   repay   : send underlying   → (нет receive)
  //
  // КРИТИЧНО: проверяем `isReceiptOfProtocol(sym, protocol.id)`, а НЕ
  // глобальный `m.isProtocolToken`. Иначе GLV в Morpho-tx ошибочно
  // помечается как Morpho receipt (потому что GLV глобально protocol-token
  // от GMX), и tx 22.11 классифицируется как `lend_withdraw` вместо
  // `lend_supply` (collateral GLV) + borrow (USDC).
  const protoId = protocol?.id ?? "";
  // КРИТИЧНО: различаем supply-receipt'ы (aToken: aWETH, aUSDC) и
  // debt-receipt'ы (variableDebtXxx). При borrow user получает И underlying
  // И debt-receipt одновременно — без этого различия классификатор путает
  // `pool.borrow()` с `pool.supply()` и теряет всю историю займов
  // (netBorrowed=0 → стартовая=$0, accrued=весь долг — баг Alex POS-007).
  const sentDebt = sends.some((s) => isDebtReceiptOfProtocol(s.symbol, protoId));
  const recvDebt = receives.some((r) => isDebtReceiptOfProtocol(r.symbol, protoId));
  // Supply-receipt = isReceiptOfProtocol МИНУС debt-receipt.
  // То есть aTokens (aWETH, aArbUSDC), но НЕ variableDebt.
  const isSupplyReceipt = (sym: string): boolean =>
    isReceiptOfProtocol(sym, protoId) && !isDebtReceiptOfProtocol(sym, protoId);
  const sentSupply = sends.some((s) => isSupplyReceipt(s.symbol));
  const recvSupply = receives.some((r) => isSupplyReceipt(r.symbol));

  // 1) borrow: получили variableDebt (новая долговая позиция). Может также
  //    приходить asset (USDC) как proceeds — это нормально для Aave V3.
  if (recvDebt && !sentDebt) {
    return base(it, seq, "borrow", protocol, movement, status);
  }
  // 2) repay: отдали variableDebt (погасили часть долга, debt-receipt сжигается).
  if (sentDebt && !recvDebt) {
    return base(it, seq, "repay", protocol, movement, status);
  }
  // 3) supply: получили aToken (новая supply-позиция).
  if (!sentSupply && recvSupply) {
    // КРИТИЧНО: combined supply+borrow в одной tx (Fluid Vault open: send
    // ETH, receive fVLT + USDC borrowed). Если в receives есть underlying
    // НЕ совпадающий ни с одним из sent (т.е. это не «получил тот же
    // токен который отдал»), это borrow-компонент. Помечаем note чтобы
    // metrics.computeBorrowInterestForToken мог достать borrow amount.
    const sentSyms = new Set(sends.map((s) => s.symbol.toUpperCase()));
    const hasBorrowComponent = receives.some(
      (r) =>
        !isSupplyReceipt(r.symbol) &&
        !isDebtReceiptOfProtocol(r.symbol, protoId) &&
        !sentSyms.has(r.symbol.toUpperCase()) &&
        r.amount > 0,
    );
    return base(
      it,
      seq,
      "lend_supply",
      protocol,
      movement,
      status,
      hasBorrowComponent ? ["combined-supply-borrow"] : [],
    );
  }
  // 4) withdraw: отдали aToken (закрыли supply).
  if (sentSupply && !recvSupply) {
    // Симметрично: combined withdraw+repay (Fluid close: send fVLT + USDC,
    // receive ETH back). Если в sends есть underlying что НЕ просто
    // «отдал тот же токен что получил», это repay-компонент.
    const recvSyms = new Set(receives.map((r) => r.symbol.toUpperCase()));
    const hasRepayComponent = sends.some(
      (s) =>
        !isSupplyReceipt(s.symbol) &&
        !isDebtReceiptOfProtocol(s.symbol, protoId) &&
        !recvSyms.has(s.symbol.toUpperCase()) &&
        s.amount > 0,
    );
    return base(
      it,
      seq,
      "lend_withdraw",
      protocol,
      movement,
      status,
      hasRepayComponent ? ["combined-withdraw-repay"] : [],
    );
  }

  // Receipt-less протоколы (Morpho Blue): receipt'а нет, всё движение —
  // underlying. Используем направление + heuristic'и по asset type'ам.
  //
  //   sends only → разделяем по типу отданного актива:
  //     - стейбл (USDC/USDT/DAI) → `repay` (стейблы — типичная борровая
  //       валюта; sending стейбл-only без receipt = погашение долга)
  //     - non-stable underlying → `lend_supply` (collateral deposit:
  //       пользователь добавляет залог чтобы улучшить HF). Например
  //       06.12.2025 GLV → Morpho = доп. supply, не repay (нельзя
  //       репайнуть GLV когда долг = USDC).
  //     - receipt чужого протокола (GLV в Morpho, stETH в Aave) →
  //       обязательно `lend_supply` — нельзя репайнуть долг чужим
  //       receipt-токеном.
  //
  //   receives only → borrow (получили занятые средства).
  //
  //   sends && receives (combined: supply + borrow одной tx) → supply
  //     с note "compound-supply-borrow". Reducer Phase 4+ разнесёт это в
  //     compound events; пока трактуем как supply.
  if (!sends.length && receives.length) {
    return base(it, seq, "borrow", protocol, movement, status);
  }
  if (sends.length && !receives.length) {
    // Все sends — стейблы → это репай долга (стейбл = типичная
    // борровая валюта в Morpho/Aave/Compound).
    const allStables = sends.every((s) => s.isStable);
    if (allStables) {
      return base(it, seq, "repay", protocol, movement, status);
    }
    // Иначе это collateral supply (non-stable underlying или receipt
    // другого протокола). Это ОБЫЧНЫЙ паттерн: пользователь добавляет
    // залог чтобы улучшить health factor.
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
  movement: TokenMovement[],
): ClassifiedOp {
  const sendsLp = sends.some((s) => s.isProtocolToken);
  const recvLp = receives.some((r) => r.isProtocolToken);

  // Gauge unstake (Velodrome/Aerodrome CL Slipstream): `CLGauge.withdraw(tokenId)`
  // возвращает позиционный NFT из gauge в кошелёк — protocol-token IN, при этом
  // ничего не уходит. Это РАССТЕЙК, не внесение ликвидности. Без guard'а ветка
  // `recvLp && !sendsLp` ниже метит его `lp_add` → ложный opener (POS-011).
  // Реальный mint имеет sends (underlying) → сюда не попадает.
  // ВАЖНО: тот же fix есть в серверном apps/api/.../classifier.ts (параллельный
  // pipeline — менять синхронно).
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
  // Обычный обмен.
  if (sends.length && receives.length) {
    return base(it, seq, "swap", protocol, movement, status);
  }
  // V3-style паттерны без явного receipt-token движения:
  //  - sends only → `increaseLiquidity` в существующий NFT (доп. ликвидность)
  //    или collectFees (claim, не обнаружим без receives — но там обычно есть)
  //  - receives only → `decreaseLiquidity` partial (вывели ликвидность из NFT)
  //    ИЛИ `collect` (снятие накопленных fee'ев без burn ликвидности).
  //    Различаем по `tx.name`: "collect"/"collectAll" → claim_rewards,
  //    "multicall" / "decreaseLiquidity"+"collect" → lp_remove.
  //
  // Без NFT в movement classifyDex иначе вернул бы "unknown" и потерял
  // эти ops для cost basis tracking. Для V3-style помечаем lp_add/lp_remove
  // (без note, чтобы не путать с async-deposit pairs).
  if (sends.length && !receives.length) {
    return base(it, seq, "lp_add", protocol, movement, status, [
      "v3-increase-liquidity",
    ]);
  }
  if (receives.length && !sends.length) {
    // V3-style receives-only — это либо `collect()` (снятие fee'ев, NFT
    // остаётся), либо `multicall(decreaseLiquidity, collect)` (вывод
    // ликвидности + collect одновременно), либо чистый `decreaseLiquidity`
    // (без transfer'а, не появляется в DeBank movement → не сюда).
    //
    // DeBank `tx.name`/`cate_id` не всегда дают однозначный сигнал
    // (multicall в V3 — обёртка любого набора call'ов, по имени не
    // отличить collect-only от decrease+collect). Поэтому используем
    // **default-to-collect** + opt-out на явные "remove"-сигналы:
    //   1) Default: classify as `claim_rewards` (collect fees) — это самый
    //      частый user action в V3 и пропустить его страшнее, чем ошибочно
    //      пометить раз-другой выход (даже там DeBank live state — ground
    //      truth, и реально закрытая позиция исчезнет с дашборда).
    //   2) Opt-out → `lp_remove` если cate_id или fnName явно говорят
    //      "withdraw"/"remove"/"decrease"/"burn"/"exit".
    const fnLower = (it.tx?.name ?? "").toLowerCase();
    // Все V3 receives-only ops классифицируем как `claim_rewards`.
    //
    // Обоснование: `tx.name` от DeBank невозможно надёжно различить между
    // collect-only и multicall(decrease+collect). Любая попытка opt-out на
    // имена функций пропускает реальные fee claims (баг POS-003 на Alex
    // 2026-05-08, $33.93 fee пропали). А мат-инвариант closed-position PnL
    // (`withdrawnUsd + claimedRewardsUsd − depositedUsd`) НЕ меняется
    // от пере-меток между этими двумя категориями: total PnL одинаковый.
    //
    // Реально закрытая позиция всё равно исчезает из live state (DeBank
    // ground truth), и в дашборде она не отобразится как открытая.
    const isClaim = true;
    // Диагностический лог для V3 receives-only ops — позволит увидеть
    // реальные fnName/cate_id значения и подкрутить эвристику.
    if (typeof window !== "undefined" && protocol?.name?.match(/V3|V4/i)) {
      console.info(
        `[V3 receives-only] ${protocol.name} ${it.chain} tx=${it.id.slice(0, 10)} ` +
          `fnName="${it.tx?.name ?? ""}" cate_id="${it.cate_id ?? ""}" → ` +
          `${isClaim ? "claim_rewards" : "lp_remove"} ` +
          `(receives: ${receives.map((r) => `${r.amount.toFixed(4)} ${r.symbol}`).join("+")})`,
      );
    }
    if (isClaim) {
      return base(it, seq, "claim_rewards", protocol, movement, status, [
        "v3-collect-fees",
      ]);
    }
    return base(it, seq, "lp_remove", protocol, movement, status, [
      "v3-decrease-liquidity",
    ]);
  }
  // P1: NPM collect() с ПУСТЫМ movement. DeBank иногда не отдаёт суммы для
  // fee-collect (zero-fee collect или gap) — обе стороны пусты, ветки выше не
  // срабатывают, и op падал в `unknown`. `collect` на DEX — или любой прямой
  // вызов Uniswap V3 NonfungiblePositionManager — это fee-claim. Численно
  // инертно: пустой movement → $0; classifyJunk ставит junk:empty_movement →
  // isJunkOp держит вне fee-движка; реальную сумму fee владеет Krystal.
  // protocol.id chain-префиксуем (eth-строки приходят как голый "uniswap3"),
  // generically — Velodrome/Aerodrome collect сохраняет свой id. Зеркало server.
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
    // P2: value-less пустой movement на DEX-проекте (approve/setApprovalForAll на
    // Aerodrome/Uniswap V4, либо прочий state-only вызов) → out of `unknown`.
    if (APPROVE_FNS.has(fnName)) {
      return base(it, seq, "approve", protocol, movement, status);
    }
    return base(it, seq, "noise", protocol, movement, status);
  }
  return base(it, seq, "unknown", protocol, movement, status);
}

function buildMovements(
  it: DeBankHistoryItem,
  ctx: ClassifyContext,
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
  tokens: Record<string, DeBankToken>,
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
  notes?: string[],
): ClassifiedOp {
  const netUsd =
    movement
      .filter((m) => m.direction === "in")
      .reduce((s, m) => s + (m.usd ?? 0), 0) -
    movement
      .filter((m) => m.direction === "out")
      .reduce((s, m) => s + (m.usd ?? 0), 0);
  const fromLc = it.tx?.from_addr?.toLowerCase();
  // selfAddress знаем только из контекста — здесь без него,
  // но контрагент ≈ "тот, кто не равен from нашего tx";
  // фактически пробрасываем to_addr, если from = self.
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
