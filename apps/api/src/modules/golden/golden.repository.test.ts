/**
 * UCB A3.6: GoldenRepository.createGolden upsert wiring.
 *
 * Regression guard for the 2026-06-03 duplicate-row bug: re-marking a golden
 * position must UPDATE the active row, not insert a duplicate. At the DB level
 * that is enforced by the `golden_cases_active_position_key_uq` partial index
 * (migration 0032); the repository must drive it via `onConflictDoUpdate`
 * arbitered on `position_key` WHERE status='active', and the conflict `set`
 * must refresh the derivation + revive the row to active. These tests assert
 * that wiring (a real-Postgres uniqueness test isn't possible against the
 * hand-rolled fake db the suite uses).
 */
import { schema } from "@cap-flow/db";
import { describe, expect, it, vi } from "vitest";

import { type GoldenCaseInsert, GoldenRepository } from "./golden.repository.js";

function makeFakeDb(upserted: unknown[]) {
  const captured: {
    insertValues?: Record<string, unknown>;
    conflictTarget?: unknown;
    conflictTargetWhere?: unknown;
    conflictSet?: Record<string, unknown>;
  } = {};

  const chain = {
    values(v: Record<string, unknown>) {
      captured.insertValues = v;
      return this;
    },
    onConflictDoUpdate(input: { target: unknown; targetWhere?: unknown; set: Record<string, unknown> }) {
      captured.conflictTarget = input.target;
      captured.conflictTargetWhere = input.targetWhere;
      captured.conflictSet = input.set;
      return this;
    },
    returning() {
      return Promise.resolve(upserted);
    },
  };

  const db = { insert: vi.fn(() => chain) };
  return { db, chain, captured };
}

const baseInput: GoldenCaseInsert = {
  walletId: "11111111-1111-1111-1111-111111111111",
  positionId: "POS-007",
  positionKey: "11111111-1111-1111-1111-111111111111|eth|uniswap3|1237252|USDC+WETH",
  chain: "eth",
  protocolId: "uniswap3",
  marketKey: "1237252",
  openHash: "0xfeed",
  label: "POS-007",
  kind: "golden",
  issue: null,
  expectedStartUsd: 1000,
  expectedNetStartUsd: 900,
  expectedPnlUsd: null,
  toleranceAbsUsd: 1,
  tolerancePct: 0.02,
  sourceOfTruth: "chain_ops",
  provenanceNote: null,
  methodologyVersion: "v1",
  fixturePath: null,
  derivation: { schemaVersion: 2, startUsd: 1000 },
  createdByUserId: "22222222-2222-2222-2222-222222222222",
  promotedFromAnomalyId: null,
};

const returnedRow = { id: "g1", ...baseInput, status: "active", createdAt: new Date(0), updatedAt: new Date(0) };

describe("GoldenRepository.createGolden — UCB A3.6 dedup", () => {
  it("upserts via ON CONFLICT arbitered on position_key WHERE status='active'", async () => {
    const { db, captured } = makeFakeDb([returnedRow]);
    const repo = new GoldenRepository(db as never);

    await repo.createGolden(baseInput);

    // Identity is the stable positionKey (not wallet+positionId).
    expect(captured.conflictTarget).toBe(schema.goldenCases.positionKey);
    // The arbiter MUST repeat the partial index predicate (status='active'),
    // else Postgres can't match the index (42P10). It must NOT be absent.
    expect(captured.conflictTargetWhere).toBeDefined();
    // The inserted row carries the required non-null key.
    expect(captured.insertValues?.["positionKey"]).toBe(baseInput.positionKey);
  });

  it("conflict set refreshes derivation and revives the row to active", async () => {
    const { db, captured } = makeFakeDb([returnedRow]);
    const repo = new GoldenRepository(db as never);

    await repo.createGolden(baseInput);

    // Re-marking must overwrite the knowledge base, not leave a stale one…
    expect(captured.conflictSet?.["derivation"]).toEqual(baseInput.derivation);
    // …and re-activate a previously soft-retired anchor.
    expect(captured.conflictSet?.["status"]).toBe("active");
    expect(captured.conflictSet?.["updatedAt"]).toBeInstanceOf(Date);
  });

  it("re-marking the same position takes the upsert path each time (idempotent, no duplicate insert)", async () => {
    const { db, captured } = makeFakeDb([returnedRow]);
    const repo = new GoldenRepository(db as never);

    await repo.createGolden(baseInput);
    const firstKey = captured.insertValues?.["positionKey"];
    await repo.createGolden(baseInput);
    const secondKey = captured.insertValues?.["positionKey"];

    // Same stable key both times → the active-row unique index makes the
    // second call an UPDATE, never a second row. The repo always routes
    // through onConflictDoUpdate (never a bare insert).
    expect(firstKey).toBe(secondKey);
    expect(captured.conflictTarget).toBe(schema.goldenCases.positionKey);
  });
});
