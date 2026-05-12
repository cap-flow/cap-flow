/**
 * Авто-генератор ручного учёта Capflow из массива ClassifiedOp[].
 *
 * Воспроизводит ту же модель, что пользователь ведёт вручную:
 *   - buy        — для swap'ов (USDT → ETH, USDC → SOL и т.д.)
 *   - open       — для lend_supply / lp_add / depo (с posType, funds, lp-параметрами)
 *   - close      — для lp_remove / lend_withdraw, привязка к открытию по протоколу
 *   - loan_take  — для borrow, со ссылкой `loanPosId` на ближайшую `open` lending
 *   - loan_return— для repay (returnType="debt") и lend_withdraw (returnType="collateral")
 *   - dividend   — для claim_rewards со ссылкой на open в комменте
 *   - fee        — для перевода gas (опционально, из gasUsd суммируется отдельно)
 *
 * Поле `price` — USD-стоимость суммы по cost-basis (weighted average) на момент tx.
 * Поле `avgPrice` — текущая средневзвешенная для cur2 после операции.
 *
 * Все записи получают id вида `BC-NNN` (Blockchain Capflow), `source: "auto"`.
 */

import type { ClassifiedOp } from "../portfolio/types";
import { isStableSymbol } from "../portfolio/protocols";
import { FundsTracker } from "../portfolio/funds_tracker";
import type { ManualOp } from "./types";

/* -------------------------- cost basis ledger ---------------------------- */

class CostBasis {
  private map = new Map<string, { amount: number; totalUsd: number }>();

  receive(symbol: string, amount: number, usd: number | null) {
    const cur = this.map.get(symbol) ?? { amount: 0, totalUsd: 0 };
    if (usd != null) {
      cur.amount += amount;
      cur.totalUsd += usd;
    } else {
      // USD неизвестен — наследуем средневзвешенную, не двигая avg.
      const avg = cur.amount > 0 ? cur.totalUsd / cur.amount : 0;
      cur.amount += amount;
      cur.totalUsd += avg * amount;
    }
    this.map.set(symbol, cur);
  }

  send(symbol: string, amount: number) {
    const cur = this.map.get(symbol);
    if (!cur || cur.amount <= 0) return;
    const avg = cur.totalUsd / cur.amount;
    cur.totalUsd -= avg * amount;
    cur.amount -= amount;
    if (cur.amount < 1e-9) {
      cur.amount = 0;
      cur.totalUsd = 0;
    }
    this.map.set(symbol, cur);
  }

  avg(symbol: string): number | null {
    if (isStableSymbol(symbol)) return 1;
    const cur = this.map.get(symbol);
    if (!cur || cur.amount === 0) return null;
    return cur.totalUsd / cur.amount;
  }

  costFor(symbol: string, amount: number): number | null {
    const a = this.avg(symbol);
    return a != null ? a * amount : null;
  }
}

/* ------------------------------- generator ------------------------------- */

export interface GenerateInput {
  /**
   * Список загруженных кошельков с операциями. Используем wallet.name
   * для проставления `from`/`to` в ManualOp (не "Binance" / walletName,
   * а реальные имена, которые пользователь задал при подключении).
   */
  loaded: { walletName: string; walletAddress: string; ops: ClassifiedOp[] }[];
}

export interface GenerateResult {
  manual: ManualOp[];
  /** id ManualOp → исходный hash блокчейн-tx, чтобы matcher мог сверять. */
  hashByManualId: Record<string, string>;
}

const STABLE_FALLBACK_PRICE = 1;

const CHAIN_TO_NETWORK: Record<string, string> = {
  eth: "Ethereum",
  arb: "Arbitrum",
  op: "Optimism",
  matic: "Polygon",
  bsc: "BNB Chain",
  base: "Base",
  avax: "Avalanche",
  ftm: "Fantom",
  sol: "Solana",
};

export function generateManualLedger(input: GenerateInput): GenerateResult {
  // Объединяем все op'ы со всех кошельков, помечая wallet.name для каждой.
  const tagged: { op: ClassifiedOp; walletName: string }[] = [];
  for (const l of input.loaded) {
    for (const op of l.ops) tagged.push({ op, walletName: l.walletName });
  }
  tagged.sort((a, b) => a.op.time - b.op.time);
  const sorted = tagged.map((t) => t.op);
  const walletByOpHash = new Map(tagged.map((t) => [t.op.hash, t.walletName]));

  const cb = new CostBasis();
  const ft = new FundsTracker();
  const manual: ManualOp[] = [];
  const hashByManualId: Record<string, string> = {};
  let counter = 1;

  /** Открытые lending-позиции по ключу `${protocolId}@${chain}` → posId (BC-NNN). */
  const openLending = new Map<string, string>();
  /** Открытые LP-позиции аналогично. */
  const openLp = new Map<string, string>();
  /** Открытые depo-позиции по протоколу. */
  const openDepo = new Map<string, string>();

  function nextId(): string {
    return `BC-${String(counter++).padStart(3, "0")}`;
  }

  function nameFor(addr: string | null | undefined): string | null {
    if (!addr) return null;
    const lc = addr.toLowerCase();
    for (const l of input.loaded) {
      if (l.walletAddress.toLowerCase() === lc) return l.walletName;
    }
    return null;
  }

  for (const op of sorted) {
    if (op.status === "failed") continue;

    const date = isoDate(op.time);
    const network = CHAIN_TO_NETWORK[op.chain] ?? op.chain.toUpperCase();
    const sends = op.movement.filter((m) => m.direction === "out");
    const receives = op.movement.filter((m) => m.direction === "in");
    // Реальное имя кошелька, которому принадлежит эта tx.
    const walletName = walletByOpHash.get(op.hash) ?? "Wallet";
    // gasUsd прокидывается во ВСЕ ManualOp этой tx — по умолчанию идёт
    // в каждом mk(), patch может его переопределить.
    const opGasUsd = op.gasUsd ?? null;

    // Локальный wrapper над mk: добавляет gasUsd по умолчанию, чтобы не
    // повторяться в каждом case. patch всё равно может переопределить.
    const mkOp = (
      id: string,
      type: ManualOp["type"],
      patch: Partial<ManualOp>,
    ): ManualOp =>
      mk(id, date, type, { gasUsd: opGasUsd, ...patch });

    switch (op.type) {
      /* ---------------------- BUY (swap / deposit/withdraw fiat) -------- */

      case "swap":
      case "deposit_fiat":
      case "withdraw_fiat":
      case "transfer_in":
      case "transfer_out": {
        if (sends.length === 1 && receives.length === 1) {
          const s = sends[0]!;
          const r = receives[0]!;
          const usdSent = cb.costFor(s.symbol, s.amount) ?? s.usd ?? null;
          cb.send(s.symbol, s.amount);
          cb.receive(r.symbol, r.amount, usdSent);
          // Taint наследуется через swap — заёмные GHO → заёмные USDT и т.д.
          const composition = ft.swap(s.symbol, s.amount, r.symbol, r.amount);
          const id = nextId();
          const fromName = (op.type === "deposit_fiat"
            ? extractCexNote(op)
            : nameFor(op.counterparty)) ?? "External";
          manual.push(
            mkOp(id, "buy", {
              from: op.type === "deposit_fiat" ? fromName : walletName,
              to: op.type === "withdraw_fiat" ? fromName : walletName,
              cur1: s.symbol,
              amount1: s.amount,
              cur2: r.symbol,
              amount2: r.amount,
              rate: r.amount > 0 ? s.amount / r.amount : null,
              avgPrice: cb.avg(r.symbol),
              network,
              funds: composition.borrowedShare > 0.5 ? "borrowed" : "own",
              borrowedShare: composition.borrowedShare,
              comment:
                op.type === "deposit_fiat"
                  ? `Auto: deposit from CEX (${op.protocol?.name ?? "?"})`
                  : op.type === "withdraw_fiat"
                  ? `Auto: withdraw to CEX`
                  : composition.borrowedShare > 0
                  ? `Auto: swap ${composition.borrowedShare === 1 ? "(на заёмные " + composition.borrowedSource + ")" : `(${Math.round(composition.borrowedShare * 100)}% заёмные)`}`
                  : op.protocol
                  ? `Auto: ${op.protocol.name} swap`
                  : "Auto: DEX swap",
            }),
          );
          hashByManualId[id] = op.hash;
          break;
        }

        // Любой pure-receive (без отправки): deposit_fiat / transfer_in от
        // внешнего адреса / приход с другого своего кошелька (cross-chain).
        if (receives.length === 1 && sends.length === 0) {
          const r = receives[0]!;
          cb.receive(r.symbol, r.amount, r.usd ?? r.amount * STABLE_FALLBACK_PRICE);
          ft.receive(r.symbol, r.amount, "own");
          const id = nextId();
          // from-метка: для CEX — имя биржи; для transfer_in — имя
          // встречного кошелька (если он в наших) или "External".
          const ownCounterparty = nameFor(op.counterparty);
          const fromLabel =
            op.type === "deposit_fiat"
              ? extractCexNote(op) ?? "CEX"
              : ownCounterparty ?? "External";
          const isInternal = ownCounterparty != null;
          manual.push(
            mkOp(id, "buy", {
              from: fromLabel,
              to: walletName,
              cur1: r.symbol,
              amount1: r.amount,
              avgPrice: cb.avg(r.symbol),
              network,
              funds: "own",
              comment:
                op.type === "deposit_fiat"
                  ? `Auto: deposit from CEX (${op.protocol?.name ?? "?"})`
                  : isInternal
                  ? `Auto: перевод между своими кошельками (${fromLabel} → ${walletName})`
                  : `Auto: incoming from ${fromLabel}`,
            }),
          );
          hashByManualId[id] = op.hash;
          break;
        }

        if (sends.length === 1 && receives.length === 0) {
          const s = sends[0]!;
          cb.send(s.symbol, s.amount);
          ft.consume(s.symbol, s.amount);
          const id = nextId();
          manual.push(
            mkOp(id, "buy", {
              from: walletName,
              to: extractCexNote(op) ?? nameFor(op.counterparty) ?? "External",
              cur1: s.symbol,
              amount1: s.amount,
              network,
              comment:
                op.type === "withdraw_fiat"
                  ? "Auto: withdraw to CEX"
                  : "Auto: transfer out",
              funds: "own",
            }),
          );
          hashByManualId[id] = op.hash;
        }
        break;
      }

      /* ---------------------- LEND_SUPPLY → open Лендинг ---------------- */

      case "lend_supply": {
        if (!op.protocol || sends.length === 0) break;
        const main = sends[0]!;
        const composition = ft.consume(main.symbol, main.amount);
        cb.send(main.symbol, main.amount);
        const priceUsd = cb.costFor(main.symbol, main.amount) ?? main.usd ?? null;
        const id = nextId();
        const isBorrowed = composition.borrowedShare > 0.5;
        manual.push(
          mkOp(id, "open", {
            from: walletName,
            to: op.protocol.name,
            cur1: main.symbol,
            amount1: main.amount,
            price: priceUsd,
            posType: "Лендинг",
            funds: isBorrowed ? "borrowed" : "own",
            borrowedShare: composition.borrowedShare,
            loanFrom: isBorrowed ? composition.borrowedSource : null,
            loanPosId: isBorrowed ? composition.borrowedOpId : null,
            network,
            comment: `Auto: supply to ${op.protocol.name}${
              composition.borrowedShare > 0
                ? ` (${Math.round(composition.borrowedShare * 100)}% заёмные${composition.borrowedSource ? " · " + composition.borrowedSource : ""})`
                : ""
            }`,
          }),
        );
        hashByManualId[id] = op.hash;
        openLending.set(`${op.protocol.id}@${op.chain}`, id);
        break;
      }

      /* ---------------------- LP_ADD → open Пул ликвидности ------------- */

      case "lp_add": {
        if (!op.protocol) break;
        const main = sends[0];
        const secondary = sends[1];
        if (!main) break;

        // Для yield/perp депозитов это "Пул ликвидности" / "Депозит",
        // а не классический LP-add двух токенов.
        const isPoolDeposit =
          op.protocol.category === "yield" ||
          op.protocol.category === "perp" ||
          op.notes?.some((n) => n.includes("yield-deposit") || n.includes("perp-deposit"));
        const posType = isPoolDeposit ? "Пул ликвидности" : "Пул ликвидности";

        // Считаем композицию по обоим токенам — это даёт reliable share.
        let totalUsd = 0;
        let totalBorrowedUsd = 0;
        let borrowedSource: string | null = null;
        let borrowedOpId: string | null = null;

        for (const s of sends) {
          const composition = ft.consume(s.symbol, s.amount);
          cb.send(s.symbol, s.amount);
          const lineUsd =
            cb.costFor(s.symbol, s.amount) ?? s.usd ?? 0;
          totalUsd += lineUsd;
          const total = composition.ownAmount + composition.borrowedAmount;
          if (total > 0) {
            totalBorrowedUsd += lineUsd * (composition.borrowedAmount / total);
            if (composition.borrowedAmount > 0) {
              if (!borrowedSource) borrowedSource = composition.borrowedSource;
              if (!borrowedOpId) borrowedOpId = composition.borrowedOpId;
            }
          }
        }
        const borrowedShare = totalUsd > 0 ? totalBorrowedUsd / totalUsd : 0;
        const isBorrowed = borrowedShare > 0.5;

        const id = nextId();
        manual.push(
          mkOp(id, "open", {
            from: walletName,
            to: op.protocol.name,
            cur1: main.symbol,
            amount1: main.amount,
            cur2: secondary?.symbol ?? null,
            amount2: secondary?.amount ?? null,
            price: totalUsd || null,
            posType,
            funds: isBorrowed ? "borrowed" : "own",
            borrowedShare,
            loanFrom: isBorrowed ? borrowedSource : null,
            loanPosId: isBorrowed ? borrowedOpId : null,
            network,
            lpVersion: detectLpVersion(op.protocol.name),
            lpPair: secondary
              ? `${main.symbol}/${secondary.symbol}`
              : main.symbol,
            comment: `Auto: ${isPoolDeposit ? "deposit to" : "LP add"} ${op.protocol.name}${
              borrowedShare > 0
                ? ` (${Math.round(borrowedShare * 100)}% заёмные${borrowedSource ? " · " + borrowedSource : ""})`
                : ""
            }`,
          }),
        );
        hashByManualId[id] = op.hash;
        openLp.set(`${op.protocol.id}@${op.chain}`, id);
        break;
      }

      /* ---------------------- BORROW → loan_take ------------------------ */

      case "borrow": {
        if (!op.protocol || receives.length === 0) break;
        const main = receives[0]!;
        cb.receive(main.symbol, main.amount, main.usd ?? main.amount * (isStableSymbol(main.symbol) ? STABLE_FALLBACK_PRICE : 0));
        const id = nextId();
        const collateralPosId =
          openLending.get(`${op.protocol.id}@${op.chain}`) ?? null;
        // Помечаем приход как заёмные с указанием протокола-источника и id.
        ft.receive(main.symbol, main.amount, "borrowed", op.protocol.name, id);
        manual.push(
          mkOp(id, "loan_take", {
            from: null,
            to: walletName,
            cur1: main.symbol,
            amount1: main.amount,
            loanFrom: op.protocol.name,
            loanPosId: collateralPosId,
            loanRateTake: null,
            network,
            comment: `Auto: borrow ${main.symbol} from ${op.protocol.name}`,
          }),
        );
        hashByManualId[id] = op.hash;
        break;
      }

      /* ---------------------- REPAY → loan_return debt ------------------ */

      case "repay": {
        if (!op.protocol || sends.length === 0) break;
        const main = sends[0]!;
        ft.repay(main.symbol, main.amount);
        cb.send(main.symbol, main.amount);
        const id = nextId();
        const collateralPosId =
          openLending.get(`${op.protocol.id}@${op.chain}`) ?? null;
        manual.push(
          mkOp(id, "loan_return", {
            from: walletName,
            to: op.protocol.name,
            cur1: main.symbol,
            amount1: main.amount,
            returnPosId: collateralPosId,
            returnType: "debt",
            network,
            comment: `Auto: repay ${main.symbol} to ${op.protocol.name}`,
          }),
        );
        hashByManualId[id] = op.hash;
        break;
      }

      /* ---------------------- LEND_WITHDRAW → loan_return collateral ---- */

      case "lend_withdraw": {
        if (!op.protocol || receives.length === 0) break;
        const main = receives[0]!;
        cb.receive(main.symbol, main.amount, cb.costFor(main.symbol, main.amount) ?? main.usd);
        ft.receive(main.symbol, main.amount, "own");
        const id = nextId();
        const collateralPosId =
          openLending.get(`${op.protocol.id}@${op.chain}`) ?? null;
        manual.push(
          mkOp(id, "loan_return", {
            from: op.protocol.name,
            to: walletName,
            cur1: main.symbol,
            amount1: main.amount,
            returnPosId: collateralPosId,
            returnType: "collateral",
            network,
            comment: `Auto: withdraw collateral from ${op.protocol.name}`,
          }),
        );
        hashByManualId[id] = op.hash;
        break;
      }

      /* ---------------------- LP_REMOVE → close ------------------------- */

      case "lp_remove": {
        if (!op.protocol) break;
        for (const r of receives) {
          cb.receive(r.symbol, r.amount, r.usd ?? null);
          ft.receive(r.symbol, r.amount, "own");
        }
        const id = nextId();
        const main = receives[0];
        const closePosId = openLp.get(`${op.protocol.id}@${op.chain}`) ?? null;
        manual.push(
          mkOp(id, "close", {
            from: op.protocol.name,
            to: walletName,
            cur1: main?.symbol ?? null,
            amount1: main?.amount ?? null,
            closeTokenAmount: main?.amount ?? null,
            closeCur2: receives[1]?.symbol ?? null,
            closeAmount2: receives[1]?.amount ?? null,
            network,
            comment: closePosId
              ? `Auto: close LP (open: ${closePosId})`
              : "Auto: LP remove",
          }),
        );
        hashByManualId[id] = op.hash;
        if (closePosId) openLp.delete(`${op.protocol.id}@${op.chain}`);
        break;
      }

      /* ---------------------- STAKE → open Депозит ---------------------- */

      case "stake": {
        if (!op.protocol || sends.length === 0) break;
        const main = sends[0]!;
        const composition = ft.consume(main.symbol, main.amount);
        cb.send(main.symbol, main.amount);
        for (const r of receives) {
          cb.receive(r.symbol, r.amount, cb.costFor(main.symbol, main.amount));
          // LST/LRT-токен наследует ту же taint-метку, что и базовый
          const total = composition.ownAmount + composition.borrowedAmount;
          if (total > 0 && composition.ownAmount > 0) {
            ft.receive(r.symbol, r.amount * (composition.ownAmount / total), "own");
          }
          if (total > 0 && composition.borrowedAmount > 0) {
            ft.receive(
              r.symbol,
              r.amount * (composition.borrowedAmount / total),
              "borrowed",
              composition.borrowedSource,
              composition.borrowedOpId,
            );
          }
        }
        const priceUsd = cb.costFor(main.symbol, main.amount) ?? main.usd;
        const id = nextId();
        manual.push(
          mkOp(id, "open", {
            from: walletName,
            to: op.protocol.name,
            cur1: main.symbol,
            amount1: main.amount,
            price: priceUsd ?? null,
            posType: "Депозит",
            funds: "own",
            network,
            comment: `Auto: stake to ${op.protocol.name}`,
          }),
        );
        hashByManualId[id] = op.hash;
        openDepo.set(`${op.protocol.id}@${op.chain}`, id);
        break;
      }

      case "unstake": {
        if (!op.protocol || receives.length === 0) break;
        for (const r of receives) {
          cb.receive(r.symbol, r.amount, null);
          ft.receive(r.symbol, r.amount, "own");
        }
        for (const s of sends) {
          cb.send(s.symbol, s.amount);
          ft.consume(s.symbol, s.amount);
        }
        const id = nextId();
        const main = receives[0]!;
        manual.push(
          mkOp(id, "close", {
            from: op.protocol.name,
            to: walletName,
            cur1: main.symbol,
            amount1: main.amount,
            closeTokenAmount: main.amount,
            network,
            comment: `Auto: unstake from ${op.protocol.name}`,
          }),
        );
        hashByManualId[id] = op.hash;
        openDepo.delete(`${op.protocol.id}@${op.chain}`);
        break;
      }

      /* ---------------------- CLAIM_REWARDS → dividend ------------------ */

      case "claim_rewards": {
        if (receives.length === 0) break;
        for (const r of receives) {
          cb.receive(r.symbol, r.amount, r.usd ?? null);
          ft.receive(r.symbol, r.amount, "own"); // награды — это твои свои деньги
        }
        const id = nextId();
        const main = receives[0]!;
        // Связь с открытием — ищем по протоколу.
        const linkedPosId =
          (op.protocol &&
            (openDepo.get(`${op.protocol.id}@${op.chain}`) ??
              openLp.get(`${op.protocol.id}@${op.chain}`) ??
              openLending.get(`${op.protocol.id}@${op.chain}`))) ??
          null;
        manual.push(
          mkOp(id, "dividend", {
            from: op.protocol?.name ?? "Protocol",
            to: walletName,
            cur1: main.symbol,
            amount1: main.amount,
            network,
            comment: linkedPosId
              ? `Сбор по позиции ${linkedPosId}`
              : `Auto: claim rewards`,
          }),
        );
        hashByManualId[id] = op.hash;
        break;
      }

      /* ---------------------- Approve / Bridge / прочее ----------------- */

      case "bridge_out": {
        const main = sends[0];
        if (!main) break;
        // Паркуем композицию в transit; bridge_in её подхватит и сохранит taint.
        const composition = ft.bridgeOut(main.symbol, main.amount, op.time);
        cb.send(main.symbol, main.amount);
        const id = nextId();
        manual.push(
          mkOp(id, "buy", {
            from: walletName,
            to: `${op.protocol?.name ?? "Bridge"} (${network})`,
            cur1: main.symbol,
            amount1: main.amount,
            network,
            funds: composition.borrowedShare > 0.5 ? "borrowed" : "own",
            borrowedShare: composition.borrowedShare,
            comment: `Bridge OUT: ${main.amount} ${main.symbol} через ${op.protocol?.name ?? "?"}${
              composition.borrowedShare > 0
                ? ` · ${Math.round(composition.borrowedShare * 100)}% заёмные`
                : ""
            }`,
          }),
        );
        hashByManualId[id] = op.hash;
        break;
      }
      case "bridge_in": {
        const main = receives[0];
        if (!main) break;
        // Подбираем парный bridge_out — taint восстанавливается автоматически.
        const matched = ft.bridgeIn(main.symbol, main.amount, op.time);
        cb.receive(main.symbol, main.amount, null);
        const id = nextId();
        const share = matched
          ? matched.ownAmount + matched.borrowedAmount > 0
            ? matched.borrowedAmount / (matched.ownAmount + matched.borrowedAmount)
            : 0
          : 0;
        manual.push(
          mkOp(id, "buy", {
            from: `${op.protocol?.name ?? "Bridge"} (${network})`,
            to: walletName,
            cur1: main.symbol,
            amount1: main.amount,
            network,
            funds: share > 0.5 ? "borrowed" : "own",
            borrowedShare: share,
            comment: `Bridge IN: ${main.amount} ${main.symbol} через ${op.protocol?.name ?? "?"}${
              share > 0
                ? ` · ${Math.round(share * 100)}% заёмные${matched?.borrowedSource ? " · " + matched.borrowedSource : ""}`
                : ""
            }`,
          }),
        );
        hashByManualId[id] = op.hash;
        break;
      }

      case "approve":
      case "perp_open":
      case "perp_close":
      case "gas_topup":
      case "unknown":
      default:
        // Не генерируем для approve / unknown — это шум.
        break;
    }
  }

  return { manual, hashByManualId };
}

/* ----------------------------- helpers ------------------------------------ */

function mk(
  id: string,
  date: string,
  type: ManualOp["type"],
  patch: Partial<ManualOp>,
): ManualOp {
  return {
    id,
    date,
    type,
    source: "auto",
    from: null,
    to: null,
    cur1: null,
    amount1: null,
    cur2: null,
    amount2: null,
    rate: null,
    price: null,
    avgPrice: null,
    posType: null,
    funds: null,
    loanRate: null,
    loanRateTake: null,
    loanFrom: null,
    loanPosId: null,
    loanLtv: null,
    loanLiqPct: null,
    loanLiqPrice: null,
    loanCollateralUsd: null,
    lpVersion: null,
    lpPair: null,
    lpPriceLow: null,
    lpPriceHigh: null,
    lpPriceOpen: null,
    lpFeeTier: null,
    lpNftId: null,
    network: null,
    commissionNetwork: null,
    closeTokenAmount: null,
    closeCur2: null,
    closeAmount2: null,
    reinvestPosId: null,
    returnPosId: null,
    returnType: null,
    direction: null,
    comment: "",
    dividendFunds: null,
    gasUsd: null,
    ...patch,
  };
}

function isoDate(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function extractCexNote(op: ClassifiedOp): string | null {
  const m = (op.notes ?? []).find((n) => /from CEX|to CEX/i.test(n));
  if (!m) return null;
  const name = m.split(":").pop()?.trim();
  return name ?? null;
}

function detectLpVersion(name: string): string | null {
  if (/uniswap\s*v3|uniswap-v3|uni\s*v3/i.test(name)) return "V3";
  if (/uniswap\s*v2|uniswap-v2|uni\s*v2/i.test(name)) return "V2";
  return null;
}

