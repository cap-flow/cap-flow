/**
 * A3.2 — golden fixture serializer round-trip.
 *
 * `replayInputToFixture` is the inverse of `fixtureToReplayInput`; together
 * they let us capture a live position's exact pipeline inputs and freeze them
 * as a committed JSON oracle. These tests prove the two directions compose
 * losslessly so an exported fixture replays byte-identically.
 */
import { describe, expect, it } from "vitest";

import {
  fixtureToReplayInput,
  replayInputToFixture,
  tagBigints,
  reviveBigints,
  type GoldenFixture,
} from "./golden_fixture";
import { replayPositions, type ReplayInput } from "./replay_positions";
import simpleAaveEth from "../__fixtures__/golden/simple-aave-eth.json";

const f = simpleAaveEth as unknown as GoldenFixture;

describe("replayInputToFixture (A3.2 export serializer)", () => {
  it("round-trips: fixture → ReplayInput → fixture is structurally identical", () => {
    const input = fixtureToReplayInput(f);
    const rebuilt = replayInputToFixture({
      label: f.label,
      methodologyVersion: f.methodologyVersion,
      input,
      anchor: f.position.anchor,
      match: f.position.match,
      expected: f.expected,
      provenance: f.provenance,
      schemaVersion: f.schemaVersion,
    });
    // JSON-equal: the rebuilt fixture must serialize to the same shape as the
    // original committed one (map ordering preserved by entries()).
    expect(JSON.parse(JSON.stringify(rebuilt))).toEqual(
      JSON.parse(JSON.stringify(f)),
    );
  });

  it("re-derived fixture replays to the same startUsd as the original", () => {
    const input = fixtureToReplayInput(f);
    const rebuilt = replayInputToFixture({
      label: f.label,
      methodologyVersion: f.methodologyVersion,
      input,
      anchor: f.position.anchor,
      match: f.position.match,
      expected: f.expected,
      provenance: f.provenance,
      schemaVersion: f.schemaVersion,
    });
    const a = replayPositions(fixtureToReplayInput(f));
    const b = replayPositions(fixtureToReplayInput(rebuilt));
    expect(JSON.stringify(b.positions)).toBe(JSON.stringify(a.positions));
  });

  it("bigint codec round-trips V3 inputs through JSON (tag → stringify → revive)", () => {
    // Synthetic V3 inputs with bigints (tokenId/liquidity) — proves the codec
    // survives a real JSON round-trip without the browser.
    const v3PositionMap = new Map<string, unknown[]>([
      ["w1", [{ tokenId: 1221698n, liquidity: 9999999999n, amount0Current: 1.5 }]],
    ]);
    const v3CostBasis = new Map<string, unknown>([
      ["eth|1221698", { tokenId: 1221698n, startUsd: 1121.81 }],
    ]);
    const input = {
      wallets: [],
      v3PositionMap,
      v3CostBasis,
    } as unknown as ReplayInput;
    const fixture = replayInputToFixture({
      label: "V3-BIGINT",
      methodologyVersion: "v",
      input,
      anchor: { chain: "eth", protocolId: "uniswap3", marketKey: null, openHash: null },
      match: "protocolId",
      expected: { startUsd: 1121.81 },
      provenance: { sourceOfTruth: "chain_ops", note: "" },
    });
    // Must be JSON-safe (no raw bigint) — this is the crux.
    const json = JSON.stringify(fixture);
    const reloaded = fixtureToReplayInput(
      JSON.parse(json) as GoldenFixture,
    );
    const pos = reloaded.v3PositionMap!.get("w1")![0] as { tokenId: bigint };
    expect(typeof pos.tokenId).toBe("bigint");
    expect(pos.tokenId).toBe(1221698n);
    const cb = reloaded.v3CostBasis!.get("eth|1221698") as { tokenId: bigint };
    expect(cb.tokenId).toBe(1221698n);
  });

  it("tagBigints/reviveBigints are pure inverses on nested structures", () => {
    const v = { a: 1n, b: [2n, { c: 3n, d: "x" }], e: null };
    const round = reviveBigints(JSON.parse(JSON.stringify(tagBigints(v))));
    expect(round).toEqual(v);
  });

  it("omits absent optional map inputs (no empty keys leak in)", () => {
    const fixture = replayInputToFixture({
      label: "X",
      methodologyVersion: "v",
      input: { wallets: [] },
      anchor: { chain: "eth", protocolId: "p", marketKey: null, openHash: null },
      match: "protocolId",
      expected: { startUsd: 0 },
      provenance: { sourceOfTruth: "manual", note: "" },
    });
    expect(fixture.input.histPrices).toBeUndefined();
    expect(fixture.input.cexCostBasisByHash).toBeUndefined();
    expect(fixture.lotMethodology).toBeUndefined();
    expect(fixture.input.wallets).toEqual([]);
  });
});
