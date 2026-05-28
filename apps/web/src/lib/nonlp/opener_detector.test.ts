import { describe, expect, it } from "vitest";

import { resolveOpenersFromTransfers } from "./opener_detector";

type T = {
  timeStamp: number;
  blockNumber: number;
  hash: string;
  from: string;
  to: string;
  contractAddress: string;
  value: string;
  tokenDecimal: number;
};

const WALLET = "0x10b850c3abfca78d693c9cd6fce809c129109d1c";
const VAULT = "0x5401b8620e5fb570064ca9114fd1e135fd77d57c"; // Lombard LBTCv
const STAKING = "0x475be1b034139f4a0ec46dd47843aaaaaaaaaaaa"; // Convex-like contract
const STAKE_TOKEN = "0xaaaa000000000000000000000000000000000001";

function tx(p: Partial<T>): T {
  return {
    timeStamp: 1700000000,
    blockNumber: 1,
    hash: "0xhash",
    from: WALLET,
    to: "0xother",
    contractAddress: "0xtoken",
    value: "1000000",
    tokenDecimal: 6,
    ...p,
  };
}

describe("resolveOpenersFromTransfers", () => {
  it("vault: receipt token заминчен (contract==lpTokenId, to==wallet)", () => {
    const transfers = [
      tx({
        timeStamp: 1760606147,
        blockNumber: 23589271,
        hash: "0xmint",
        from: "0xvaultminter",
        to: WALLET,
        contractAddress: VAULT,
        value: "696635",
        tokenDecimal: 8,
      }),
    ];
    const out = resolveOpenersFromTransfers(transfers, [VAULT]);
    expect(out.size).toBe(1);
    const op = out.get(VAULT)!;
    expect(op.openedAt).toBe(1760606147);
    expect(op.openBlock).toBe(23589271);
    expect(op.receiptAmount).toBeCloseTo(0.00696635, 8);
  });

  it("staking: токен отправлен В контракт (to==lpTokenId)", () => {
    const transfers = [
      tx({
        timeStamp: 1750000000,
        blockNumber: 100,
        hash: "0xstake",
        from: WALLET,
        to: STAKING, // депозит в стейк-контракт
        contractAddress: STAKE_TOKEN,
        value: "5000000",
        tokenDecimal: 6,
      }),
    ];
    const out = resolveOpenersFromTransfers(transfers, [STAKING]);
    expect(out.size).toBe(1);
    expect(out.get(STAKING)!.openedAt).toBe(1750000000);
  });

  it("берёт САМЫЙ РАННИЙ matched transfer (несколько взаимодействий)", () => {
    const transfers = [
      tx({ timeStamp: 1760000000, to: STAKING, hash: "0xlate" }),
      tx({ timeStamp: 1750000000, to: STAKING, hash: "0xearly" }),
      tx({ timeStamp: 1755000000, to: STAKING, hash: "0xmid" }),
    ];
    const out = resolveOpenersFromTransfers(transfers, [STAKING]);
    expect(out.get(STAKING)!.openedAt).toBe(1750000000);
    expect(out.get(STAKING)!.txHash).toBe("0xearly");
  });

  it("резолвит несколько lpTokenId за один проход", () => {
    const transfers = [
      tx({ timeStamp: 1750000000, to: STAKING, hash: "0xstake" }),
      tx({ timeStamp: 1760000000, from: "0xv", to: WALLET, contractAddress: VAULT, hash: "0xmint" }),
    ];
    const out = resolveOpenersFromTransfers(transfers, [STAKING, VAULT]);
    expect(out.size).toBe(2);
    expect(out.get(STAKING)!.openedAt).toBe(1750000000);
    expect(out.get(VAULT)!.openedAt).toBe(1760000000);
  });

  it("lpTokenId без единого matched transfer → не в результате", () => {
    const transfers = [tx({ to: "0xunrelated", contractAddress: "0xunrelated" })];
    const out = resolveOpenersFromTransfers(transfers, [STAKING]);
    expect(out.size).toBe(0);
  });

  it("case-insensitive матч lpTokenId", () => {
    const transfers = [tx({ timeStamp: 1750000000, to: STAKING.toLowerCase() })];
    const out = resolveOpenersFromTransfers(transfers, [STAKING.toUpperCase()]);
    expect(out.size).toBe(1);
  });

  it("from==lpTokenId (receipt/reward пришёл из контракта) тоже матчит", () => {
    const transfers = [
      tx({ timeStamp: 1750000000, from: STAKING, to: WALLET, hash: "0xreward" }),
    ];
    const out = resolveOpenersFromTransfers(transfers, [STAKING]);
    expect(out.size).toBe(1);
    expect(out.get(STAKING)!.openedAt).toBe(1750000000);
  });

  it("пустой transfers list → пустой результат", () => {
    expect(resolveOpenersFromTransfers([], [STAKING]).size).toBe(0);
  });

  it("пустой receiptTokens list → пустой результат", () => {
    const transfers = [tx({ to: STAKING })];
    expect(resolveOpenersFromTransfers(transfers, []).size).toBe(0);
  });
});
