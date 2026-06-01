/**
 * A2 — offline golden-replay harness test.
 *
 * Proves `replayPositions` reproduces the canonical cost-basis pipeline from
 * FROZEN inputs, fully offline (no network / hooks / localStorage). This is
 * the behavioural safety net that must pass before any engine extraction (A0).
 */
import { describe, expect, it } from "vitest";

import { replayPositions, type ReplayInput } from "./replay_positions";
import {
  fixtureToReplayInput,
  findGoldenPosition,
  matchesAnchor,
  withinTolerance,
  type GoldenAssertion,
  type GoldenFixture,
} from "./golden_fixture";
import simpleAaveEth from "../__fixtures__/golden/simple-aave-eth.json";

/** Normalize a fixture to its list of asserted anchors (multi or single). */
function assertionsOf(f: GoldenFixture): GoldenAssertion[] {
  if (f.anchors && f.anchors.length > 0) return f.anchors;
  return [
    {
      label: f.label,
      anchor: f.position.anchor,
      match: f.position.match,
      expected: f.expected,
    },
  ];
}

// A3.2: auto-glob every committed golden fixture so newly-seeded anchors
// (curated on the test account → exported to this dir) are picked up by the
// regression suite automatically — no manual import needed. Eager import so
// the values are available synchronously at describe-time.
const globbed = import.meta.glob("../__fixtures__/golden/*.json", {
  eager: true,
}) as Record<string, { default: unknown }>;

const FIXTURES: GoldenFixture[] = Object.values(globbed).map(
  (m) => m.default as GoldenFixture,
);

describe("replayPositions — golden fixtures (offline)", () => {
  for (const f of FIXTURES) {
    describe(`golden: ${f.label}`, () => {
      const { positions } = replayPositions(fixtureToReplayInput(f));

      for (const a of assertionsOf(f)) {
        describe(a.label, () => {
          const pos = positions.find((p) =>
            matchesAnchor(p, a.anchor, a.match),
          );

          it("locates the anchored position", () => {
            expect(
              pos,
              `no position matched anchor ${JSON.stringify(a.anchor)}`,
            ).toBeDefined();
          });

          it("startUsd is the cost basis, within tolerance", () => {
            if (a.expected.startUsd === undefined) return;
            expect(pos).toBeDefined();
            const ok = withinTolerance(
              pos!.startUsd,
              a.expected.startUsd,
              a.expected.toleranceAbsUsd,
              a.expected.tolerancePct,
            );
            expect(
              ok,
              `startUsd=${pos!.startUsd} expected≈${a.expected.startUsd}`,
            ).toBe(true);
          });

          it("currentUsd (live) within tolerance", () => {
            if (a.expected.currentUsd === undefined) return;
            expect(pos).toBeDefined();
            const cur = pos!.supplyTokens.reduce((s, t) => s + t.currentUsd, 0);
            const ok = withinTolerance(
              cur,
              a.expected.currentUsd,
              a.expected.toleranceAbsUsd,
              a.expected.tolerancePct,
            );
            expect(
              ok,
              `currentUsd=${cur} expected≈${a.expected.currentUsd}`,
            ).toBe(true);
          });
        });
      }
    });
  }

  it("SIMPLE-AAVE-ETH: startUsd is cost basis ($2000), NOT live spot ($3000)", () => {
    const f = simpleAaveEth as unknown as GoldenFixture;
    const { positions } = replayPositions(fixtureToReplayInput(f));
    const pos = findGoldenPosition(positions, f);
    expect(pos).toBeDefined();
    // The whole point of cost basis: it must not be the $3000 current value.
    expect(pos!.startUsd).toBeLessThan(2500);
    expect(pos!.startUsd).toBeGreaterThan(1900);
    // And it must come from traced lots, not a silent m.usd fallback.
    const fallback = pos!.supplyTokens.reduce(
      (s, t) => s + (t.fallbackUsd ?? 0),
      0,
    );
    expect(fallback, "cost basis should be lot-traced, no spot fallback").toBe(
      0,
    );
  });

  it("is deterministic: two replays of the same input are identical", () => {
    const f = simpleAaveEth as unknown as GoldenFixture;
    const a = replayPositions(fixtureToReplayInput(f));
    const b = replayPositions(fixtureToReplayInput(f));
    expect(JSON.stringify(a.positions)).toBe(JSON.stringify(b.positions));
  });

  it("empty input yields no positions (harness no-op safety)", () => {
    const input: ReplayInput = { wallets: [] };
    const { positions, positionsRaw } = replayPositions(input);
    expect(positions).toEqual([]);
    expect(positionsRaw).toEqual([]);
  });
});
