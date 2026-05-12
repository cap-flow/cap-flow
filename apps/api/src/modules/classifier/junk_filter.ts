/**
 * Junk-классификатор для on-chain ops — server port of
 * `apps/web/src/lib/portfolio/junk_filter.ts` (P5.1).
 *
 * Помечает op'ы которые НЕ должны влиять на портфель, но захламляют:
 *   • `scam_airdrop` — спам-токены (xxx.io, claim, voucher, эмодзи)
 *   • `dust`         — все movement'ы < $0.50
 *   • `mev_failure`  — failed tx с реальным газом
 *   • `unknown_phantom` — receives без USD-цены, не stable
 *
 * Метки кладутся в `op.notes`. Analytics + cost-basis ИГНОРИРУЕТ ops с
 * `junk:*` префиксом. Не помечает реальные airdrops (LDO, ARB, OP, …).
 */

import { isStableSymbol } from "./protocols.js";
import type { ClassifiedOp, TokenMovement } from "./types.js";

const KNOWN_AIRDROP_TOKENS = new Set([
  "LDO",
  "ARB",
  "OP",
  "JTO",
  "PYTH",
  "JUP",
  "ZK",
  "STRK",
  "ZRO",
  "ENA",
  "EIGEN",
  "WLD",
  "BLUR",
  "DYM",
  "PIXEL",
  "PORTAL",
  "MANTA",
  "AERO",
  "VELO",
  "GMX",
  "RDNT",
  "MAGIC",
  "TIA",
  "INJ",
  "OSMO",
]);

const SCAM_PATTERNS = [
  /\.io\b/i,
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
  /\$\s*\w+/i,
  /https?:\/\//i,
  /www\./i,
];

function hasSuspiciousChars(symbol: string): boolean {
  return /[^\x20-\x7EЀ-ӿ]/.test(symbol);
}

function isSuspiciousToken(m: TokenMovement): boolean {
  const sym = m.symbol;
  if (!sym) return true;
  if (KNOWN_AIRDROP_TOKENS.has(sym.toUpperCase())) return false;
  if (isStableSymbol(sym)) return false;
  if (sym.length > 20) return true;
  for (const re of SCAM_PATTERNS) {
    if (re.test(sym)) return true;
  }
  if (hasSuspiciousChars(sym)) return true;
  return false;
}

export function classifyJunk(op: ClassifiedOp): string[] {
  const tags: string[] = [];

  if (op.status === "failed") {
    if (op.gasUsd != null && op.gasUsd > 0.01) {
      tags.push("junk:mev_failure");
    } else {
      tags.push("junk:failed");
    }
    return tags;
  }

  if (
    op.movement.length === 0 &&
    op.type !== "approve" &&
    op.type !== "failed"
  ) {
    tags.push("junk:empty_movement");
  }

  const meaningful = op.movement.filter(
    (m) => m.amount > 0 && (m.usd ?? 0) >= 0.5
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

  const hasReceives = op.movement.some(
    (m) => m.direction === "in" && m.amount > 0
  );
  const hasSends = op.movement.some(
    (m) => m.direction === "out" && m.amount > 0
  );
  const eligibleType =
    op.type === "transfer_in" ||
    op.type === "claim_rewards" ||
    op.type === "unknown";
  if (eligibleType && hasReceives && !hasSends) {
    const receivedTokens = op.movement.filter(
      (m) => m.direction === "in" && m.amount > 0
    );
    const allSuspicious = receivedTokens.every(isSuspiciousToken);
    if (allSuspicious) {
      tags.push("junk:scam_airdrop");
    }
  }

  if (op.type === "unknown" && hasReceives && !hasSends) {
    const receives = op.movement.filter(
      (m) => m.direction === "in" && m.amount > 0
    );
    const allPhantom = receives.every(
      (m) => (m.usd == null || m.usd < 0.01) && !isStableSymbol(m.symbol)
    );
    if (allPhantom && !tags.includes("junk:scam_airdrop")) {
      tags.push("junk:unknown_phantom");
    }
  }

  return tags;
}

export function isJunkOp(op: ClassifiedOp): boolean {
  if (!op.notes) return false;
  return op.notes.some((n) => n.startsWith("junk:"));
}

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
