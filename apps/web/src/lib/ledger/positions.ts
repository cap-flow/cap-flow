import type {
  LedgerPosition,
  LedgerSummary,
  ManualOp,
} from "./types";

/* -------------------------------------------------------------------------- */
/*  Построение списка позиций из плоского массива операций                    */
/* -------------------------------------------------------------------------- */

const POS_REF_RE = /OP-\d+/g;

/**
 * Group ManualOp[] → LedgerPosition[]:
 *   - каждая `open` создаёт позицию (key = openOp.id)
 *   - связи разносятся по полям loans/loanReturns/dividends/reinvests/closeOp
 *   - dividend без явного reinvestPosId — связываем по упоминанию OP-id в comment
 */
export function buildPositions(operations: ManualOp[]): LedgerPosition[] {
  const positions = new Map<string, LedgerPosition>();

  for (const op of operations) {
    if (op.type === "open") {
      positions.set(op.id, {
        id: op.id,
        openOp: op,
        closeOp: null,
        isOpen: true,
        project: op.to ?? "?",
        posType: op.posType,
        funds: op.funds,
        network: op.network,
        loans: [],
        loanReturns: [],
        dividends: [],
        reinvests: [],
        initialAmount: op.amount1 ?? 0,
        initialCurrency: op.cur1 ?? "?",
        initialUsd: op.price ?? null,
        totalDividendsUsd: 0,
        totalBorrowedUsd: 0,
        totalReturnedCollateralAmount: 0,
      });
    }
  }

  for (const op of operations) {
    switch (op.type) {
      case "loan_take": {
        if (op.loanPosId && positions.has(op.loanPosId)) {
          const p = positions.get(op.loanPosId)!;
          p.loans.push(op);
          p.totalBorrowedUsd +=
            op.amount1 != null && (op.cur1 === "USDT" || op.cur1 === "USDC")
              ? op.amount1
              : 0;
        }
        break;
      }
      case "loan_return": {
        if (op.returnPosId && positions.has(op.returnPosId)) {
          const p = positions.get(op.returnPosId)!;
          p.loanReturns.push(op);
          if (op.returnType === "collateral" && op.amount1 != null) {
            p.totalReturnedCollateralAmount += op.amount1;
          }
        }
        break;
      }
      case "close": {
        // Закрываем позицию по сумме открытия (грубо: cur1 совпадает с открытием).
        // В исходных данных нет прямой ссылки на open id у close — пробуем по from+cur1.
        const candidates = Array.from(positions.values()).filter(
          (p) =>
            p.isOpen &&
            (p.project === op.from || p.openOp.from === op.from) &&
            p.openOp.cur1 === op.cur1,
        );
        // Берём наиболее подходящую — самую раннюю открытую.
        const target = candidates.sort(
          (a, b) => +new Date(a.openOp.date) - +new Date(b.openOp.date),
        )[0];
        if (target) {
          target.closeOp = op;
          target.isOpen = false;
        }
        break;
      }
      case "dividend": {
        // Связь по упоминанию OP-id в комменте (как в экспорте: «Сбор по позиции OP-051»).
        const refs = op.comment.match(POS_REF_RE) ?? [];
        for (const ref of refs) {
          if (positions.has(ref)) {
            const p = positions.get(ref)!;
            p.dividends.push(op);
            if (op.amount1 && (op.cur1 === "USDT" || op.cur1 === "USDC")) {
              p.totalDividendsUsd += op.amount1;
            }
          }
        }
        break;
      }
      case "reinvest": {
        if (op.reinvestPosId && positions.has(op.reinvestPosId)) {
          positions.get(op.reinvestPosId)!.reinvests.push(op);
        }
        break;
      }
      default:
        break;
    }
  }

  return Array.from(positions.values()).sort(
    (a, b) => +new Date(b.openOp.date) - +new Date(a.openOp.date),
  );
}

/* -------------------------------------------------------------------------- */
/*  Сводка (стартовый капитал и т.д.)                                          */
/* -------------------------------------------------------------------------- */

export function buildSummary(
  operations: ManualOp[],
  positions: LedgerPosition[],
): LedgerSummary {
  let rubIn = 0;
  let usdtFromRub = 0;
  let weightedRate = 0;

  for (const op of operations) {
    if (op.type !== "buy") continue;
    // Включаем как ручные RUB→USDT записи, так и авто-buy с проставленной
    // RUB-аннотацией (после enrichOps cur1 уже = "RUB").
    if (
      op.cur1 === "RUB" &&
      (op.cur2 === "USDT" || op.cur2 === "USDC") &&
      op.amount1 &&
      op.amount2
    ) {
      rubIn += op.amount1;
      usdtFromRub += op.amount2;
      weightedRate += (op.rate ?? op.amount1 / op.amount2) * op.amount2;
    }
  }
  const avgRubPerUsdt = usdtFromRub > 0 ? weightedRate / usdtFromRub : null;

  const feesByNetwork: Record<string, number> = {};
  for (const op of operations) {
    if (op.type !== "fee") continue;
    const key = op.network ?? "Unknown";
    feesByNetwork[key] = (feesByNetwork[key] ?? 0) + (op.amount1 ?? 0);
  }

  return {
    startingCapitalRub: rubIn,
    startingCapitalUsdt: usdtFromRub,
    avgRubPerUsdt,
    feesByNetwork,
    positionsCount: positions.length,
    openPositionsCount: positions.filter((p) => p.isOpen).length,
    closedPositionsCount: positions.filter((p) => !p.isOpen).length,
  };
}
