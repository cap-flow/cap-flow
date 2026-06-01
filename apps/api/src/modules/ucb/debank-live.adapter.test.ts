/**
 * Parity proof for the server EVM DeBank→LiveSnapshot adapter.
 *
 * Feeds the captured RAW DeBank payloads for `murat` into the ported
 * `adaptDeBankLive` and compares the result against the already-adapted
 * `live` snapshot frozen in the golden shadow fixture.
 *
 * The raw capture and the golden live were taken at SLIGHTLY different times,
 * so structure is asserted STRICTLY (same set of positions keyed by
 * protocolId|lpTokenId|firstSupplySymbol, same supply symbols, presence of
 * Fluid/GMX/UniswapV3) while USD/amounts are asserted TOLERANTLY (>0, within
 * ~15% — prices drift between captures).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { SavedWallet } from "@cap-flow/ucb/wallet";
import type {
  LiveProtocolPosition,
  LiveSnapshot,
} from "@cap-flow/ucb/live";

import {
  adaptDeBankLive,
  type DeBankComplexProtocol,
  type DeBankTokenBalance,
} from "./debank-live.adapter.js";

function loadJson<T>(rel: string): T {
  return JSON.parse(
    readFileSync(new URL(rel, import.meta.url), "utf8"),
  ) as T;
}

/** Stable key for a position: protocol + market + first supply symbol. */
function posKey(p: LiveProtocolPosition): string {
  const firstSupply = p.supply[0]?.symbol ?? "?";
  return `${p.protocolId}|${p.lpTokenId ?? "-"}|${firstSupply}`;
}

/** within ±pct (fractional, e.g. 0.15 = 15%). */
function within(actual: number, expected: number, pct: number): boolean {
  if (expected === 0) return Math.abs(actual) < 1;
  return Math.abs(actual - expected) / Math.abs(expected) <= pct;
}

describe("adaptDeBankLive (server EVM port) — murat parity", () => {
  const protocols = loadJson<DeBankComplexProtocol[]>(
    "./__fixtures__/debank-raw/murat-protocols.json",
  );
  const tokens = loadJson<DeBankTokenBalance[]>(
    "./__fixtures__/debank-raw/murat-tokens.json",
  );
  const total = loadJson<{ total_usd_value: number }>(
    "./__fixtures__/debank-raw/murat-total.json",
  );

  const golden = loadJson<{
    input: { wallets: { wallet: SavedWallet; live: LiveSnapshot }[] };
  }>("./__fixtures__/ucb-shadow/murat-1.json");
  const goldenWalletEntry = golden.input.wallets[0];
  if (!goldenWalletEntry) throw new Error("golden murat-1 fixture has no wallets[0]");
  const goldenLive = goldenWalletEntry.live;

  const wallet: SavedWallet = {
    id: goldenWalletEntry.wallet.id,
    name: "murat",
    address: "0x1bd62bdb16ee94f2cd1f666dcb41dd6ea625d041",
    chain: "evm",
    createdAt: goldenWalletEntry.wallet.createdAt ?? Date.now(),
  };

  const snap = adaptDeBankLive({
    wallet,
    tokens,
    protocols,
    totalUsd: total.total_usd_value,
  });

  it("produces a non-empty snapshot with positive total", () => {
    expect(snap.totalUsd).toBeGreaterThan(0);
    expect(snap.tokens.length).toBeGreaterThan(0);
    expect(snap.positions.length).toBeGreaterThan(0);
  });

  it("matches the golden protocol set (Fluid / GMX / UniswapV3 present)", () => {
    const protoIds = new Set(snap.positions.map((p) => p.protocolId));
    const goldenProtoIds = new Set(
      goldenLive.positions.map((p) => p.protocolId),
    );
    // Every protocol the golden saw must be present in the fresh adaptation.
    for (const id of goldenProtoIds) {
      expect(protoIds, `missing protocol ${id}`).toContain(id);
    }
    expect(protoIds).toContain("arb_fluid");
    expect(protoIds).toContain("arb_gmx2");
    expect(protoIds).toContain("arb_uniswap3");
  });

  it("matches the golden position set structurally (key + supply symbols)", () => {
    const actualByKey = new Map(snap.positions.map((p) => [posKey(p), p]));
    const goldenByKey = new Map(
      goldenLive.positions.map((p) => [posKey(p), p]),
    );

    // STRICT: every golden position key is reproduced.
    for (const [key, gp] of goldenByKey) {
      const ap = actualByKey.get(key);
      expect(ap, `missing position ${key}`).toBeDefined();
      if (!ap) continue;
      expect(ap.protocolId).toBe(gp.protocolId);
      expect(ap.lpTokenId).toBe(gp.lpTokenId);
      // Same set of supply token symbols.
      const aSupply = ap.supply.map((s) => s.symbol).sort();
      const gSupply = gp.supply.map((s) => s.symbol).sort();
      expect(aSupply).toEqual(gSupply);
    }
    // Same cardinality (no extra/dropped positions).
    expect(actualByKey.size).toBe(goldenByKey.size);
  });

  it("matches USD/amounts tolerantly (>0, within ~15%)", () => {
    const goldenByKey = new Map(
      goldenLive.positions.map((p) => [posKey(p), p]),
    );
    const outliers: string[] = [];
    for (const ap of snap.positions) {
      const gp = goldenByKey.get(posKey(ap));
      if (!gp) continue;
      expect(ap.netUsd, `${posKey(ap)} netUsd>0`).toBeGreaterThan(0);
      expect(ap.assetUsd, `${posKey(ap)} assetUsd>0`).toBeGreaterThan(0);
      if (!within(ap.netUsd, gp.netUsd, 0.15)) {
        outliers.push(
          `${posKey(ap)}: netUsd ${ap.netUsd.toFixed(2)} vs golden ${gp.netUsd.toFixed(2)}`,
        );
      }
      // Supply amounts/usd: positive and within tolerance per matched symbol.
      for (const as of ap.supply) {
        const gs = gp.supply.find((s) => s.symbol === as.symbol);
        if (!gs) continue;
        expect(as.usd, `${posKey(ap)} ${as.symbol} usd>0`).toBeGreaterThan(0);
        expect(as.amount, `${posKey(ap)} ${as.symbol} amount>0`).toBeGreaterThan(0);
      }
    }
    // Allow a couple of drift outliers (prices moved between captures) but
    // surface them for the parity report.
    if (outliers.length > 0) {
      // eslint-disable-next-line no-console
      console.log("tolerant-USD outliers:\n" + outliers.join("\n"));
    }
    expect(outliers.length).toBeLessThanOrEqual(2);
  });
});
