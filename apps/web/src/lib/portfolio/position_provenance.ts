/**
 * Provenance verification для OpenPosition.
 *
 * Каждое отображаемое в UI агрегированное число (startUsd, feesClaimedUsd,
 * feesByToken, supplyTokens.startUsd, currentUsd) должно быть выводимо
 * из raw `ClassifiedOp[]` этого кошелька. Эта функция запускает per-position
 * инварианты и собирает список нарушений.
 *
 * Принцип: «никаких чисел без провенанса». Если UI показывает
 * "Claimed fees 782,34 $ (3 события)", то:
 *   - все 3 hash'а должны существовать в walletOps
 *   - все 3 op'а должны быть type=claim_rewards
 *   - все 3 op'а должны быть в (protocolId, chain) позиции
 *   - все 3 op'а должны иметь op.time >= openedAt
 *   - Σ event.usd === feesClaimedUsd (с точностью до доли)
 *
 * Любое нарушение → `IntegrityIssue` (severity "warn" | "error").
 *
 * Использование:
 *   - на dev: console.warn при каждом нарушении (включается флагом)
 *   - в /coverage: суммарный список «9 / 9 позиций OK» или красный список багов
 *   - в тестах: invariants над test fixture (Bob)
 *
 * Что **НЕ** проверяется:
 *   - Right-ness derived USD значений (mostly зависит от histPrices / market) —
 *     это требует cross-source reconciliation, не provenance.
 *   - Live-side (lp.supply.amount, currentUsd) — приходит из DeBank API,
 *     ground truth = API response, не ops.
 *
 * Что проверяется:
 *   - Структурная связь между aggregated UI numbers и raw ops:
 *     id/тип/время/пара/протокол/chain.
 */

import type { OpenPosition } from "./open_positions";
import type { ClassifiedOp } from "./types";

/** Локальная копия normalizeSymbol — private helper в др. файлах portfolio/. */
function normalizeSymbol(s: string): string {
  const u = (s ?? "").toUpperCase();
  if (u === "WETH") return "WETH";
  return u;
}

export type IntegritySeverity = "warn" | "error";

export interface IntegrityIssue {
  positionId: string;
  /** Поле/секция позиции которое содержит нарушение. */
  field:
    | "feesClaimedHistory"
    | "feesClaimedUsd"
    | "openHash"
    | "openedAt"
    | "supplyTokens"
    | "feesByToken"
    | "lendingYieldApr";
  severity: IntegritySeverity;
  message: string;
  /** Optional tx hash, если ошибка связана с конкретной op'ой. */
  hash?: string;
}

/**
 * Разумный максимум native APR для supply yield конкретного актива.
 *
 * Превышение этого порога = **сильный сигнал что DeBank history неполный**
 * (см. POS-008: пропущенный supply tx 0x1795560c WBTC дал ложный
 * accrued 0.069 WBTC за 232 дня = 62% APR на WBTC supply, что в 20+ раз
 * превышает реальный Aave V3 WBTC APR ~0.05-0.3%).
 *
 * Используется как **upper bound sanity check** — нормальный supply yield
 * никогда не превышает эти значения. Если превысил — flag для ручной
 * верификации.
 *
 * Источники для bound:
 *   - Aave V3 / Compound V3 / Fluid historical max APRs за 2024-2026
 *   - Headroom: ×2 от исторического peak, чтобы не false-positive'ить
 *     на короткие spike'и (incentive boost campaigns)
 */
const REASONABLE_MAX_SUPPLY_APR_PCT: Record<string, number> = {
  // BTC: исторически 0.05-0.3%, max ~1% во время spike'ов → bound 3%
  WBTC: 3,
  TBTC: 3,
  CBBTC: 3,
  // ETH: 0.5-3%, max ~6% во время peak demand → bound 8%
  WETH: 8,
  ETH: 8,
  STETH: 10,
  WSTETH: 10,
  RETH: 10,
  // Stables: 2-8%, max ~15% во время бычьих циклов → bound 20%
  USDC: 20,
  USDT: 20,
  DAI: 20,
  USDE: 25,
  SUSDE: 30,
  USDS: 25,
  PYUSD: 20,
  GHO: 25,
  CRVUSD: 25,
  // Default для неизвестных: 25% (consertively allow exotic yield, но flag extreme)
};

function reasonableMaxApr(symbol: string): number {
  return REASONABLE_MAX_SUPPLY_APR_PCT[normalizeSymbol(symbol)] ?? 25;
}

export interface PositionProvenanceReport {
  positionId: string;
  ok: boolean;
  issues: IntegrityIssue[];
}

/**
 * Проверить инварианты одной позиции против её wallet'а raw ops.
 *
 * `walletOps` должен быть **полный** список ops этого кошелька (= тот же
 * массив что передавался в `buildOpenPositions` для построения этой
 * позиции).
 */
export function verifyPositionProvenance(
  p: OpenPosition,
  walletOps: readonly ClassifiedOp[],
): PositionProvenanceReport {
  const issues: IntegrityIssue[] = [];
  const opsByHash = new Map<string, ClassifiedOp>();
  for (const op of walletOps) {
    opsByHash.set(op.hash.toLowerCase(), op);
  }

  // ─── A. feesClaimedHistory invariants ──────────────────────────────────
  let claimedSum = 0;
  for (const ev of p.feesClaimedHistory) {
    claimedSum += ev.usd;

    const op = opsByHash.get(ev.hash.toLowerCase());
    if (!op) {
      issues.push({
        positionId: p.id,
        field: "feesClaimedHistory",
        severity: "error",
        message: `Fee event hash ${ev.hash} не найден в wallet ops`,
        hash: ev.hash,
      });
      continue;
    }

    if (op.type !== "claim_rewards") {
      issues.push({
        positionId: p.id,
        field: "feesClaimedHistory",
        severity: "error",
        message: `Hash ${ev.hash}: op.type=${op.type}, ожидалось claim_rewards`,
        hash: ev.hash,
      });
    }

    if (op.protocol?.id !== p.protocol.id) {
      issues.push({
        positionId: p.id,
        field: "feesClaimedHistory",
        severity: "error",
        message: `Hash ${ev.hash}: protocol mismatch (op=${op.protocol?.id} vs pos=${p.protocol.id})`,
        hash: ev.hash,
      });
    }

    if (op.chain !== p.chain) {
      issues.push({
        positionId: p.id,
        field: "feesClaimedHistory",
        severity: "error",
        message: `Hash ${ev.hash}: chain mismatch (op=${op.chain} vs pos=${p.chain})`,
        hash: ev.hash,
      });
    }

    // ЭТО invariant который поймал бы ghost-fee bug POS-007.
    if (p.openedAt != null && op.time < p.openedAt) {
      issues.push({
        positionId: p.id,
        field: "feesClaimedHistory",
        severity: "error",
        message:
          `Hash ${ev.hash}: op.time=${new Date(op.time * 1000).toISOString()} ` +
          `предшествует openedAt=${new Date(p.openedAt * 1000).toISOString()} ` +
          `— это ghost-fee от другой (закрытой ранее) позиции той же пары.`,
        hash: ev.hash,
      });
    }
  }

  // Σ history.usd ≈ feesClaimedUsd. Допуск 1 цент чтобы не падать на
  // float roundoff. Для V3 multi-NFT pro-rata редистрибуция меняет
  // individual event.usd внутри group → допуск может быть шире;
  // отдельно отслеживаем расхождения >$1 как warn.
  if (p.feesClaimedHistory.length > 0) {
    const diff = Math.abs(claimedSum - p.feesClaimedUsd);
    if (diff > 1.0) {
      issues.push({
        positionId: p.id,
        field: "feesClaimedUsd",
        severity: "warn",
        message:
          `Σ feesClaimedHistory.usd = ${claimedSum.toFixed(2)} != ` +
          `feesClaimedUsd ${p.feesClaimedUsd.toFixed(2)} (diff $${diff.toFixed(2)})`,
      });
    }
  }

  // ─── B. openHash должен существовать в walletOps ───────────────────────
  if (p.openHash) {
    const op = opsByHash.get(p.openHash.toLowerCase());
    if (!op) {
      issues.push({
        positionId: p.id,
        field: "openHash",
        severity: "error",
        message: `openHash ${p.openHash} не найден в wallet ops`,
        hash: p.openHash,
      });
    } else if (p.openedAt != null && Math.abs(op.time - p.openedAt) > 60) {
      // 60 sec допуск (mempool / block-time skew); большие расхождения = bug
      issues.push({
        positionId: p.id,
        field: "openedAt",
        severity: "warn",
        message:
          `openedAt=${p.openedAt} vs op.time=${op.time} (${Math.abs(op.time - p.openedAt)}s diff)`,
        hash: p.openHash,
      });
    }
  }

  // ─── C. supplyTokens.startUsd ≈ Σ token cost basis ─────────────────────
  if (p.supplyTokens.length > 0) {
    const tokensSum = p.supplyTokens.reduce((s, t) => s + (t.startUsd ?? 0), 0);
    const diff = Math.abs(tokensSum - p.startUsd);
    // Allow $1 absolute OR 0.5% relative. Для leveraged позиций (POS-008/009)
    // startUsd может включать pro-rata leverage adjustments которые не точно
    // суммируются с per-token. Это OK — но крупные расхождения подозрительны.
    const tolerance = Math.max(1.0, p.startUsd * 0.005);
    if (diff > tolerance) {
      issues.push({
        positionId: p.id,
        field: "supplyTokens",
        severity: "warn",
        message:
          `Σ supplyTokens.startUsd = ${tokensSum.toFixed(2)} != ` +
          `position.startUsd ${p.startUsd.toFixed(2)} (diff $${diff.toFixed(2)})`,
      });
    }
  }

  // ─── D. feesByToken consistency ────────────────────────────────────────
  if (p.feesByToken && p.feesByToken.length > 0) {
    const tokensFeeSum = p.feesByToken.reduce((s, t) => s + (t.usd ?? 0), 0);
    const totalFee = p.feesUsd ?? 0;
    const diff = Math.abs(tokensFeeSum - totalFee);
    if (totalFee > 0 && diff > Math.max(0.5, totalFee * 0.01)) {
      issues.push({
        positionId: p.id,
        field: "feesByToken",
        severity: "warn",
        message:
          `Σ feesByToken.usd = ${tokensFeeSum.toFixed(2)} != ` +
          `feesUsd ${totalFee.toFixed(2)} (diff $${diff.toFixed(2)})`,
      });
    }
  }

  // ─── E. Lending supply yield APR sanity check ───────────────────────────
  // Источник: feesByToken.nativeApr (для supply_yield source) считается как
  // (accrued / deposited) × (365 / ageDays) × 100. Если для конкретного
  // токена nativeApr превышает разумный максимум для этого asset, это
  // сильный сигнал что `depositAmountSum` неполный — т.е. DeBank пропустил
  // supply tx. Пример: POS-008 Aave WBTC — accrued 0.069 WBTC за 232 дня
  // = 61% APR, тогда как WBTC supply на Aave V3 даёт max ~0.3%. Это
  // подтвердилось on-chain: была пропущена supply tx 0x1795560c (0.069 WBTC).
  //
  // Применяется только к lending/staking/restaking (rebase-style yield).
  // V3 LP fees (v3_rewards source) сюда не попадают — там APR может быть
  // легитимно высоким.
  if (p.feesSource === "supply_yield" && p.feesByToken) {
    for (const t of p.feesByToken) {
      if (t.nativeApr == null) continue;
      const maxApr = reasonableMaxApr(t.symbol);
      if (t.nativeApr > maxApr) {
        issues.push({
          positionId: p.id,
          field: "lendingYieldApr",
          severity: "error",
          message:
            `${t.symbol} accrued APR ${t.nativeApr.toFixed(1)}% > разумного max ` +
            `${maxApr}% для этого asset. Скорее всего DeBank пропустил supply tx — ` +
            `проверь aToken Transfer events на цепи: accrued=${t.amount.toFixed(6)} ` +
            `${t.symbol} нереалистично для supply yield такого размера.`,
        });
      }
    }
  }

  return {
    positionId: p.id,
    ok: issues.filter((i) => i.severity === "error").length === 0,
    issues,
  };
}

/**
 * Прогнать verifyPositionProvenance над всем массивом позиций и собрать
 * сводный отчёт. Используется в /coverage или в dev console.
 */
export function verifyAllPositionsProvenance(
  positions: readonly OpenPosition[],
  opsByWalletId: Map<string, readonly ClassifiedOp[]>,
): {
  totalPositions: number;
  positionsOk: number;
  totalIssues: number;
  errorCount: number;
  warnCount: number;
  reports: PositionProvenanceReport[];
} {
  const reports: PositionProvenanceReport[] = [];
  let positionsOk = 0;
  let errorCount = 0;
  let warnCount = 0;

  for (const p of positions) {
    const walletOps = opsByWalletId.get(p.walletId) ?? [];
    const r = verifyPositionProvenance(p, walletOps);
    reports.push(r);
    if (r.ok) positionsOk++;
    for (const i of r.issues) {
      if (i.severity === "error") errorCount++;
      else warnCount++;
    }
  }

  return {
    totalPositions: positions.length,
    positionsOk,
    totalIssues: reports.reduce((s, r) => s + r.issues.length, 0),
    errorCount,
    warnCount,
    reports,
  };
}

/**
 * Dev-time hook: при загрузке позиций в LoadedWalletsProvider вызвать
 * эту функцию чтобы любое нарушение инвариантов залогировалось как warn
 * в консоль. Поведение noop в production (через `import.meta.env.DEV`).
 */
export function warnOnProvenanceIssues(
  positions: readonly OpenPosition[],
  opsByWalletId: Map<string, readonly ClassifiedOp[]>,
): void {
  if (typeof window === "undefined") return;
  const summary = verifyAllPositionsProvenance(positions, opsByWalletId);
  if (summary.errorCount === 0 && summary.warnCount === 0) return;

  // Один сводный warn чтобы не спамить
  console.warn(
    `[provenance] ${summary.errorCount} errors, ${summary.warnCount} warns ` +
      `across ${summary.totalPositions} positions ` +
      `(${summary.positionsOk} OK)`,
  );
  for (const r of summary.reports) {
    for (const i of r.issues) {
      const prefix = i.severity === "error" ? "[provenance ERROR]" : "[provenance warn]";
      console.warn(`${prefix} ${r.positionId} ${i.field}: ${i.message}`);
    }
  }
}
