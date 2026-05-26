/**
 * WalletsService.addAddress dedup regression.
 *
 * User request 2026-05-25: «можно добавить 2 одинаковых адреса и
 * система сплюсует их». Раньше DB constraint (walletId, address)
 * запрещал дубль только в ОДНОМ кошельке, но 2 разных кошелька внутри
 * одного account могли держать тот же address → portfolio суммировал 2×.
 */
import { describe, expect, it, vi } from "vitest";

import { ConflictError, NotFoundError } from "../../core/errors.js";
import { WalletsService } from "./wallets.service.js";

const WALLET_ROW = {
  id: "w-1",
  accountId: "acc-1",
  name: "Hot Wallet",
  kind: "external" as const,
  createdAt: new Date(),
};

function makeService(existingAddresses: Array<{ address: string; walletName: string }> = []) {
  const repo = {
    findById: vi.fn(async (id: string) => (id === WALLET_ROW.id ? WALLET_ROW : null)),
    listAddressesByAccount: vi.fn(async () =>
      existingAddresses.map((a, i) => ({
        id: `addr-${i}`,
        walletId: WALLET_ROW.id,
        address: a.address,
        type: "evm" as const,
        chains: [1],
        createdAt: new Date(),
        walletName: a.walletName,
      })),
    ),
    addAddress: vi.fn(async (input) => ({
      id: "new-addr",
      ...input,
      createdAt: new Date(),
    })),
  };
  const accounts = {
    getById: vi.fn(async () => ({ id: "acc-1", userId: "u-1" })),
  };
  const audit = { log: vi.fn(async () => {}) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new WalletsService(repo as any, accounts as any, audit as any);
  return { svc, repo, accounts, audit };
}

const ACTOR = { id: "u-1", email: null, role: "user" as const, status: "active" as const };

describe("WalletsService.addAddress dedup", () => {
  it("EVM lowercase match → ConflictError со ссылкой на existing wallet", async () => {
    const { svc } = makeService([
      { address: "0xabcd1234abcd1234abcd1234abcd1234abcd1234", walletName: "Main Wallet" },
    ]);
    await expect(
      svc.addAddress(
        {
          walletId: "w-1",
          address: "0xABCD1234ABCD1234ABCD1234ABCD1234ABCD1234", // mixed case
          type: "evm",
          chains: [1],
        },
        ACTOR as never,
      ),
    ).rejects.toThrowError(ConflictError);
  });

  it("ConflictError message содержит имя существующего кошелька", async () => {
    const { svc } = makeService([
      { address: "0xabcd1234abcd1234abcd1234abcd1234abcd1234", walletName: "Лекс 1" },
    ]);
    try {
      await svc.addAddress(
        {
          walletId: "w-1",
          address: "0xabcd1234abcd1234abcd1234abcd1234abcd1234",
          type: "evm",
          chains: [1],
        },
        ACTOR as never,
      );
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as Error).message).toMatch(/Лекс 1/);
    }
  });

  it("разные адреса проходят без conflict", async () => {
    const { svc, repo } = makeService([
      { address: "0xabcd1234abcd1234abcd1234abcd1234abcd1234", walletName: "Main" },
    ]);
    const r = await svc.addAddress(
      {
        walletId: "w-1",
        address: "0x9999999999999999999999999999999999999999",
        type: "evm",
        chains: [1],
      },
      ACTOR as never,
    );
    expect(r.id).toBe("new-addr");
    expect(repo.addAddress).toHaveBeenCalled();
  });

  it("Solana address (не EVM) — trim, не lowercase", async () => {
    const { svc } = makeService([
      { address: "DRiP2Pn2K6fuMLKQmt5rZWxa91tYbnvf7BS84QHGm", walletName: "SOL" },
    ]);
    await expect(
      svc.addAddress(
        {
          walletId: "w-1",
          address: "  DRiP2Pn2K6fuMLKQmt5rZWxa91tYbnvf7BS84QHGm  ", // с whitespace
          type: "solana",
          chains: [],
        },
        ACTOR as never,
      ),
    ).rejects.toThrowError(ConflictError);
  });

  it("несуществующий wallet → NotFoundError (не conflict)", async () => {
    const { svc } = makeService();
    await expect(
      svc.addAddress(
        {
          walletId: "nonexistent",
          address: "0xabcd1234abcd1234abcd1234abcd1234abcd1234",
          type: "evm",
          chains: [1],
        },
        ACTOR as never,
      ),
    ).rejects.toThrowError(NotFoundError);
  });

  it("пустой address list — passes", async () => {
    const { svc, repo } = makeService([]);
    const r = await svc.addAddress(
      {
        walletId: "w-1",
        address: "0xabcd1234abcd1234abcd1234abcd1234abcd1234",
        type: "evm",
        chains: [1],
      },
      ACTOR as never,
    );
    expect(r.id).toBe("new-addr");
    expect(repo.addAddress).toHaveBeenCalled();
  });
});
