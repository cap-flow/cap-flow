/**
 * Owner-методика 2026-06-10 (testakk Artur, Morpho Blue): receives-only из
 * receipt-less lending протокола — НЕ всегда borrow.
 *
 * Реальный кейс 06.12.2025: внёс 0.22620396 WBTC в Morpho (lend_supply),
 * через 8 минут вынул те же 0.22620396 WBTC (withdrawCollateral) — старый
 * классификатор маркировал вывод залога как «borrow» (фантомный заём,
 * которого пользователь не делал; лот получал market-цену займа вместо
 * исходной базы).
 *
 * Симметрия с sends-only веткой (стейблы→repay, non-stable→lend_supply):
 *   receives-only стейбл      → borrow (стейбл — типичная заёмная валюта)
 *   receives-only non-stable  → lend_withdraw (возврат залога)
 */
import { describe, expect, it } from "vitest";

import type { DeBankHistoryItem, DeBankProject, DeBankToken } from "../debank";
import { classifyHistory } from "./classifier";

const SELF = "0xself0000000000000000000000000000000000aa";

function tok(id: string, symbol: string, price?: number): DeBankToken {
  return {
    id, chain: id.split(":")[0]!, name: symbol, symbol, decimals: 18, logo_url: null,
    ...(price !== undefined ? { price } : {}),
  };
}

const TOKENS: Record<string, DeBankToken> = {
  "arb:wbtc": tok("arb:wbtc", "WBTC", 88000),
  "arb:usdc": tok("arb:usdc", "USDC", 1),
};

function ctx() {
  return {
    ownAddresses: new Set([SELF.toLowerCase()]),
    selfAddress: SELF.toLowerCase(),
    tokens: TOKENS,
    projects: {} as Record<string, DeBankProject>,
    cex: {},
  };
}

function item(opts: {
  fnName: string;
  sends: { token: string; amount: number }[];
  receives: { token: string; amount: number }[];
}): DeBankHistoryItem {
  return {
    id: "0x" + Math.random().toString(36).slice(2, 12),
    chain: "arb", cate_id: null, time_at: 1_765_023_116,
    project_id: "arb_morphoblue", cex_id: null,
    sends: opts.sends.map((s) => ({ token_id: s.token, amount: s.amount })),
    receives: opts.receives.map((r) => ({ token_id: r.token, amount: r.amount })),
    token_approve: null,
    tx: { from_addr: SELF, to_addr: "0xext00000000000000000000000000000000000cc", status: 1, name: opts.fnName },
  } as unknown as DeBankHistoryItem;
}

describe("Morpho Blue (receipt-less) — receives-only classification", () => {
  it("non-stable receives-only (WBTC) → lend_withdraw (возврат залога, НЕ borrow)", () => {
    const ops = classifyHistory(
      [item({ fnName: "multicall", sends: [], receives: [{ token: "arb:wbtc", amount: 0.22620396 }] })],
      ctx(),
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]!.type).toBe("lend_withdraw");
  });

  it("стейбл receives-only (USDC) → borrow (заёмная валюта — без изменений)", () => {
    const ops = classifyHistory(
      [item({ fnName: "multicall", sends: [], receives: [{ token: "arb:usdc", amount: 3000 }] })],
      ctx(),
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]!.type).toBe("borrow");
  });
});
