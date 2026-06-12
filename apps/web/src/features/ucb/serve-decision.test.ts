import { describe, expect, it } from "vitest";

import {
  shouldAdoptServerPositions,
  describeAdoption,
  walletSetsEqual,
  serverPositionsValid,
  type ServePositionsResponse,
} from "./serve-decision";

// Client positions carry composite ids `api:<uuid>:<addr>`; realWalletId → uuid.
const cPos = (uuid: string) => ({ walletId: `api:${uuid}:0xabc` });

// A plausible server OpenPosition (core fields the validator + UI require).
const sPos = (uuid: string) => ({
  id: `POS-${uuid}`,
  walletId: uuid,
  chain: "arb",
  protocol: { id: "arb_fluid", name: "Fluid" },
  startUsd: 100,
  currentUsd: 120,
  supplyTokens: [],
});

const resp = (o: Partial<ServePositionsResponse> = {}): ServePositionsResponse => ({
  serve: true,
  reason: "served",
  positions: [sPos("w1")],
  lotMethodology: "LIFO",
  ...o,
});

describe("serverPositionsValid", () => {
  it("accepts well-formed positions", () => {
    expect(serverPositionsValid([sPos("w1"), sPos("w2")])).toBe(true);
  });
  it("rejects empty array", () => {
    expect(serverPositionsValid([])).toBe(false);
  });
  it("rejects malformed/partial items (missing core fields)", () => {
    expect(serverPositionsValid([{ walletId: "w1" }])).toBe(false);
    expect(serverPositionsValid([sPos("w1"), { walletId: "w2" }])).toBe(false);
    expect(serverPositionsValid([{ ...sPos("w1"), startUsd: "100" }])).toBe(false);
    expect(serverPositionsValid([{ ...sPos("w1"), protocol: null }])).toBe(false);
  });
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
  it("malformed server positions → fall back (cast guard)", () => {
    expect(shouldAdoptServerPositions({ ...base, flagEnabled: true, resp: resp({ positions: [{ walletId: "w1" }] }) })).toBe(false);
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

describe("describeAdoption — источник расчёта + причина (для UI-бейджа)", () => {
  const base = { clientLotMethodology: "LIFO", clientPositions: [cPos("w1")] };

  it("все guard'ы прошли → source=server, reason=served", () => {
    expect(describeAdoption({ ...base, flagEnabled: true, resp: resp() })).toEqual({
      source: "server",
      reason: "served",
    });
  });
  it("рассинхрон методики (melody: сервер LIFO, тогл FIFO) → client/methodology_mismatch", () => {
    expect(
      describeAdoption({ ...base, clientLotMethodology: "FIFO", flagEnabled: true, resp: resp() }),
    ).toEqual({ source: "client", reason: "methodology_mismatch" });
  });
  it("флаг выключен → client/flag_off", () => {
    expect(describeAdoption({ ...base, flagEnabled: false, resp: resp() })).toEqual({
      source: "client",
      reason: "flag_off",
    });
  });
  it("ответа сервера ещё нет → client/loading", () => {
    expect(describeAdoption({ ...base, flagEnabled: true, resp: undefined })).toEqual({
      source: "client",
      reason: "loading",
    });
  });
  it("сервер отказал по своей причине (no_shadow) → пробрасываем её", () => {
    expect(
      describeAdoption({
        ...base,
        flagEnabled: true,
        resp: resp({ serve: false, positions: null, reason: "no_shadow" }),
      }),
    ).toEqual({ source: "client", reason: "no_shadow" });
  });
  it("набор кошельков расходится → client/wallet_set_mismatch", () => {
    expect(
      describeAdoption({
        ...base,
        clientPositions: [cPos("w1"), cPos("w2")],
        flagEnabled: true,
        resp: resp({ positions: [sPos("w1")] }),
      }),
    ).toEqual({ source: "client", reason: "wallet_set_mismatch" });
  });
});
