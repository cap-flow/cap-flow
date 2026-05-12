/**
 * Junk-классификатор для on-chain ops.
 *
 * Помечает op'ы которые НЕ должны влиять на портфель, но захламляют:
 *   • `scam_airdrop` — спам-токены (ZkSync VOUCHER, claim at xxx.io, KIK Token)
 *   • `dust` — все movement'ы < $0.50, не несут реальной ценности
 *   • `mev_failure` — failed tx с реальным газом (юзер потерял gas)
 *   • `unknown_phantom` — receives без USD-значения и без матча в classifier'е
 *
 * Метки кладутся в `op.notes`. UI/analytics могут фильтровать через
 * `isJunkOp(op)`. По умолчанию analytics ИГНОРИРУЕТ junk-помеченные ops.
 *
 * Зачем:
 *  1. Cost basis tracker не получает мусорные «покупки» (scam token at $0.0001)
 *  2. Analytics не показывает мусорные «доходы» (тысячи айрдроп-токенов)
 *  3. Junk помечен явно — пользователь может включить «показать мусор» в UI
 *
 * **Не помечает** реальные airdrops от известных протоколов (LDO, ARB, OP, JTO):
 *  Это легитимная история, у которой `cost basis = 0` обрабатывается отдельно
 *  в `cost_basis_tracker` (см. addAirdrop method, P0 follow-up).
 */

import { isStableSymbol } from "./protocols";
import type { ClassifiedOp, TokenMovement } from "./types";

/** Узкий список «известных» легитимных airdrop-токенов — НЕ помечаем junk. */
const KNOWN_AIRDROP_TOKENS = new Set([
  "LDO", "ARB", "OP", "JTO", "PYTH", "JUP", "ZK", "STRK", "ZRO", "ENA",
  "EIGEN", "WLD", "BLUR", "DYM", "PIXEL", "PORTAL", "MANTA", "JTO",
  "AERO", "VELO", "GMX", "RDNT", "MAGIC", "TIA", "INJ", "OSMO",
]);

/** «Подозрительные» паттерны в symbol — почти всегда scam. */
const SCAM_PATTERNS = [
  /\.io\b/i, // "Claim at xyz.io"
  /\.com\b/i,
  /\.xyz\b/i,
  /\.app\b/i,
  /\.org\b/i,
  /visit\s+/i,
  /claim\s+/i,
  /reward[\s_-]+/i,
  /airdrop[\s_-]+/i,
  /voucher/i,
  /^t\.me\//i,
  /\$\s*\w+/i, // "$BONK Reward"
  /https?:\/\//i,
  /www\./i,
];

/** Symbols с эмодзи или non-ASCII — обычно скам. */
function hasSuspiciousChars(symbol: string): boolean {
  // Не-латиница, не-кириллица, не-цифры, не-стандартные символы
  // (кроме .-/_ которые могут быть в нормальных символах)
  return /[^\x20-\x7EЀ-ӿ]/.test(symbol);
}

/**
 * Решение: является ли movement подозрительным (token-level junk).
 *
 * Не используется напрямую — только через `classifyJunk` который смотрит
 * на op в целом.
 */
function isSuspiciousToken(m: TokenMovement): boolean {
  const sym = m.symbol;
  if (!sym) return true;
  // Известный legitimate airdrop — не помечаем.
  if (KNOWN_AIRDROP_TOKENS.has(sym.toUpperCase())) return false;
  // Стейблы не помечаем (даже если symbol необычный — защита от false-positive).
  if (isStableSymbol(sym)) return false;
  // Очень длинный symbol (>20 chars) — явно не реальный токен.
  if (sym.length > 20) return true;
  // Подозрительные паттерны.
  for (const re of SCAM_PATTERNS) {
    if (re.test(sym)) return true;
  }
  // Спецсимволы / эмодзи.
  if (hasSuspiciousChars(sym)) return true;
  return false;
}

/**
 * Анализирует op и возвращает junk-теги (если есть). Tags возвращаются как
 * массив строк — caller добавит их в `op.notes`.
 */
export function classifyJunk(op: ClassifiedOp): string[] {
  const tags: string[] = [];

  // 1. MEV failure — failed tx с потерянным газом.
  // (классификатор уже помечает status="failed"; junk-тег добавляется ТОЛЬКО
  // если был реальный газ-расход — сравниваем по `gasFeeUsd` в op).
  if (op.status === "failed") {
    if (op.gasUsd != null && op.gasUsd > 0.01) {
      tags.push("junk:mev_failure");
    } else {
      tags.push("junk:failed");
    }
    return tags; // failed ops не идут дальше — только junk-тег
  }

  // 2a. Empty movement: ops БЕЗ ВСЯКИХ движений токенов (ни in, ни out).
  // DeBank иногда возвращает такие "phantom"-ops — обычно это setting changes,
  // contract calls без денежных событий. Не должны влиять на портфель.
  if (
    op.movement.length === 0 &&
    op.type !== "approve" &&
    op.type !== "failed"
  ) {
    tags.push("junk:empty_movement");
  }

  // 2b. Dust: все movements < $0.50 И ни одно не валютное событие.
  const meaningful = op.movement.filter(
    (m) => m.amount > 0 && (m.usd ?? 0) >= 0.5,
  );
  if (
    op.movement.length > 0 &&
    meaningful.length === 0 &&
    op.type !== "approve" &&
    op.type !== "transfer_in" &&
    op.type !== "transfer_out"
  ) {
    tags.push("junk:dust");
  }

  // 3. Scam airdrop:
  //    - тип transfer_in / claim_rewards / unknown
  //    - все meaningful receives — подозрительные токены
  //    - НЕТ исходящих движений (то есть не swap, не было «покупки»)
  const hasReceives = op.movement.some(
    (m) => m.direction === "in" && m.amount > 0,
  );
  const hasSends = op.movement.some(
    (m) => m.direction === "out" && m.amount > 0,
  );
  const eligibleType =
    op.type === "transfer_in" ||
    op.type === "claim_rewards" ||
    op.type === "unknown";
  if (eligibleType && hasReceives && !hasSends) {
    const receivedTokens = op.movement.filter(
      (m) => m.direction === "in" && m.amount > 0,
    );
    const allSuspicious = receivedTokens.every(isSuspiciousToken);
    if (allSuspicious) {
      tags.push("junk:scam_airdrop");
    }
  }

  // 4. Phantom — receives с m.usd ≈ 0 или null И токен не stablecoin.
  //    Часто бывает с low-liquidity scam'ами где USD-цена 0 на DEX'ах.
  if (op.type === "unknown" && hasReceives && !hasSends) {
    const receives = op.movement.filter(
      (m) => m.direction === "in" && m.amount > 0,
    );
    const allPhantom = receives.every(
      (m) =>
        (m.usd == null || m.usd < 0.01) && !isStableSymbol(m.symbol),
    );
    if (allPhantom && !tags.includes("junk:scam_airdrop")) {
      tags.push("junk:unknown_phantom");
    }
  }

  return tags;
}

/**
 * Проверка: является ли op мусорным (любой junk-тег присутствует).
 *
 * Caller'ы (analytics, cost basis tracker, UI) фильтруют через эту функцию.
 */
export function isJunkOp(op: ClassifiedOp): boolean {
  if (!op.notes) return false;
  return op.notes.some((n) => n.startsWith("junk:"));
}

/**
 * Возвращает «причину» junk-классификации (для UI tooltip'а).
 * Если op не junk — возвращает null.
 */
export function junkReason(op: ClassifiedOp): string | null {
  if (!op.notes) return null;
  const tag = op.notes.find((n) => n.startsWith("junk:"));
  if (!tag) return null;
  switch (tag) {
    case "junk:scam_airdrop":
      return "Спам-airdrop от неизвестного протокола";
    case "junk:dust":
      return "Все движения < $0.50";
    case "junk:mev_failure":
      return "Failed tx с потерянным газом";
    case "junk:failed":
      return "Failed tx (газ ≈ $0)";
    case "junk:unknown_phantom":
      return "Получение токенов с USD-ценой ≈ $0";
    default:
      return tag.replace(/^junk:/, "");
  }
}
