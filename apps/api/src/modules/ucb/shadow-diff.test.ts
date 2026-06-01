/**
 * B5 shadow-diff comparator — pure, deterministic, no I/O.
 * Measures client-vs-server divergence: the gate that decides when the server
 * may be flipped to serve canonical positions (zero material diffs across the
 * golden anchors).
 */
import { describe, expect, it } from "vitest";

import { diffShadowPositions } from "./shadow-diff.js";

// Minimal OpenPosition-shaped stub — only the fields the comparator reads.
function pos(p: {
  chain: string;
  protocolId: string;
  lpTokenId?: string | null;
  tokenId?: string | null;
  supplySymbol?: string;
  startUsd: number;
}) {
  return {
    chain: p.chain,
    protocol: { id: p.protocolId },
    lpTokenId: p.lpTokenId ?? null,
    matchedV3TokenId: p.tokenId ?? null,
    openHash: null,
    startUsd: p.startUsd,
    supplyTokens: p.supplySymbol ? [{ symbol: p.supplySymbol }] : [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const aave = (startUsd: number) =>
  pos({ chain: "eth", protocolId: "eth_aave3", lpTokenId: "0xa", startUsd });

describe("diffShadowPositions (B5 shadow-diff)", () => {
  it("|Δ| within $1 → not divergent", () => {
    const d = diffShadowPositions([aave(2000)], [aave(2000.5)]);
    expect(d.divergentCount).toBe(0);
    expect(d.matchedCount).toBe(1);
    expect(d.deltas[0]!.deltaStartUsd).toBeCloseTo(-0.5, 6);
    expect(d.deltas[0]!.divergent).toBe(false);
  });

  it("|Δ| > $1 → divergent, counted", () => {
    const d = diffShadowPositions([aave(2000)], [aave(2002)]);
    expect(d.divergentCount).toBe(1);
    expect(d.deltas[0]!.deltaStartUsd).toBeCloseTo(-2, 6);
    expect(d.deltas[0]!.divergent).toBe(true);
  });

  it("|Δ| exactly $1 → NOT divergent (strict > threshold)", () => {
    const d = diffShadowPositions([aave(2000)], [aave(2001)]);
    expect(d.divergentCount).toBe(0);
  });

  it("client_only / server_only surfaced with null delta, not divergent", () => {
    const client = [aave(2000), pos({ chain: "arb", protocolId: "arb_gmx2", lpTokenId: "0xg", startUsd: 500 })];
    const server = [aave(2000)];
    const d = diffShadowPositions(client, server);
    expect(d.clientOnlyCount).toBe(1);
    expect(d.serverOnlyCount).toBe(0);
    expect(d.divergentCount).toBe(0);
    const only = d.deltas.find((x) => x.presence === "client_only")!;
    expect(only.deltaStartUsd).toBeNull();
    expect(only.serverStartUsd).toBeNull();
    expect(only.divergent).toBe(false);
  });

  it("decomposed positions on one receipt are keyed apart by supply symbol", () => {
    const client = [
      pos({ chain: "arb", protocolId: "arb_fluid", lpTokenId: "0xf", supplySymbol: "ETH", startUsd: 1000 }),
      pos({ chain: "arb", protocolId: "arb_fluid", lpTokenId: "0xf", supplySymbol: "WBTC", startUsd: 2000 }),
    ];
    const server = [
      pos({ chain: "arb", protocolId: "arb_fluid", lpTokenId: "0xf", supplySymbol: "ETH", startUsd: 1000 }),
      pos({ chain: "arb", protocolId: "arb_fluid", lpTokenId: "0xf", supplySymbol: "WBTC", startUsd: 2000 }),
    ];
    const d = diffShadowPositions(client, server);
    expect(d.matchedCount).toBe(2);
    expect(d.divergentCount).toBe(0);
  });

  it("deltas sorted by |Δ| desc then key; deterministic", () => {
    const client = [aave(2000), pos({ chain: "arb", protocolId: "arb_gmx2", lpTokenId: "0xg", startUsd: 500 })];
    const server = [aave(2010), pos({ chain: "arb", protocolId: "arb_gmx2", lpTokenId: "0xg", startUsd: 505 })];
    const d = diffShadowPositions(client, server);
    // aave Δ=-10 (|10|) before gmx Δ=-5 (|5|)
    expect(d.deltas.map((x) => x.presence)).toEqual(["both", "both"]);
    expect(Math.abs(d.deltas[0]!.deltaStartUsd!)).toBeGreaterThan(
      Math.abs(d.deltas[1]!.deltaStartUsd!),
    );
    // determinism
    expect(JSON.stringify(diffShadowPositions(client, server))).toBe(
      JSON.stringify(d),
    );
  });

  it("empty inputs → all zero, no deltas", () => {
    const d = diffShadowPositions([], []);
    expect(d).toMatchObject({
      divergentCount: 0,
      clientOnlyCount: 0,
      serverOnlyCount: 0,
      matchedCount: 0,
    });
    expect(d.deltas).toEqual([]);
  });
});
