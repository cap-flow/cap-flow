import { describe, expect, it } from "vitest";

import {
  shouldAdoptServerPositions,
  walletSetsEqual,
  type ServePositionsResponse,
} from "./serve-decision";

// Client positions carry composite ids `api:<uuid>:<addr>`; realWalletId → uuid.
const cPos = (uuid: string) => ({ walletId: `api:${uuid}:0xabc` });
const sPos = (uuid: string) => ({ walletId: uuid });

const resp = (o: Partial<ServePositionsResponse> = {}): ServePositionsResponse => ({
  serve: true,
  reason: "served",
  positions: [sPos("w1")],
  lotMethodology: "LIFO",
  ...o,
});

describe("walletSetsEqual", () => {
  it("equal when same wallet uuids (composite vs raw)", () => {
    expect(walletSetsEqual([cPos("w1"), cPos("w2")], [sPos("w2"), sPos("w1")])).toBe(true);
  });
  it("unequal when server references a wallet the client did not load", () => {
    expect(walletSetsEqual([cPos("w1")], [sPos("w1"), sPos("w2")])).toBe(false);
  });
  it("unequal when client loaded an extra wallet (e.g. second account)", () => {
    expect(walletSetsEqual([cPos("w1"), cPos("w2")], [sPos("w1")])).toBe(false);
  });
});

describe("shouldAdoptServerPositions", () => {
  const base = { clientLotMethodology: "LIFO", clientPositions: [cPos("w1")] };

  it("flag OFF → never adopt", () => {
    expect(shouldAdoptServerPositions({ ...base, flagEnabled: false, resp: resp() })).toBe(false);
  });
  it("no response yet → fall back", () => {
    expect(shouldAdoptServerPositions({ ...base, flagEnabled: true, resp: undefined })).toBe(false);
  });
  it("server says serve=false → fall back", () => {
    expect(shouldAdoptServerPositions({ ...base, flagEnabled: true, resp: resp({ serve: false, positions: null }) })).toBe(false);
  });
  it("methodology mismatch → fall back (FIFO shadow vs LIFO user)", () => {
    expect(shouldAdoptServerPositions({ ...base, flagEnabled: true, resp: resp({ lotMethodology: "FIFO" }) })).toBe(false);
  });
  it("wallet-set mismatch → fall back", () => {
    expect(
      shouldAdoptServerPositions({
        ...base,
        clientPositions: [cPos("w1"), cPos("w2")],
        flagEnabled: true,
        resp: resp({ positions: [sPos("w1")] }),
      }),
    ).toBe(false);
  });
  it("all guards pass → adopt", () => {
    expect(shouldAdoptServerPositions({ ...base, flagEnabled: true, resp: resp() })).toBe(true);
  });
});
