/**
 * Добавление адреса кошелька → немедленный + recurring refresh (инцидент
 * moximko 2026-06-12: новый аккаунт, созданный после бута воркера, не имел
 * recurring-refresh → нет снапшота → нет shadow → в server-only пустая
 * таблица). Роут должен дёрнуть refresh.scheduleRecurring + enqueueManual.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterEach, describe, expect, it, vi } from "vitest";

import { walletsRoutes, type WalletRefreshEnqueuer } from "./wallets.routes.js";

let app: FastifyInstance | null = null;
afterEach(async () => {
  if (app) await app.close();
  app = null;
});

const ACC = "11111111-1111-1111-1111-111111111111";
const WID = "22222222-2222-2222-2222-222222222222";

function makeRefresh(): WalletRefreshEnqueuer & {
  scheduleRecurring: ReturnType<typeof vi.fn>;
  enqueueManual: ReturnType<typeof vi.fn>;
} {
  return {
    scheduleRecurring: vi.fn(async () => {}),
    enqueueManual: vi.fn(async () => "job-1"),
  };
}

async function build(refresh?: WalletRefreshEnqueuer): Promise<FastifyInstance> {
  const f = Fastify();
  f.setValidatorCompiler(validatorCompiler);
  f.setSerializerCompiler(serializerCompiler);
  // Заглушка app.requireAuth + req.user (как делает плагин auth).
  f.decorate("requireAuth", async (req: { user?: unknown }) => {
    req.user = { id: "user-1" };
  });
  f.addHook("preHandler", async (req: { user?: unknown }) => {
    req.user = { id: "user-1" };
  });
  const service = {
    addAddress: vi.fn(async () => ({
      id: "33333333-3333-3333-3333-333333333333",
      walletId: WID,
      address: "0xabc",
      type: "evm",
      chains: [],
      createdAt: new Date(),
    })),
  } as unknown as Parameters<typeof walletsRoutes>[1]["service"];
  await f.register(walletsRoutes, {
    service,
    ...(refresh ? { refresh } : {}),
    refreshEveryMs: 1000,
    refreshJitterMs: 0,
  });
  return f;
}

const addAddress = (f: FastifyInstance) =>
  f.inject({
    method: "POST",
    url: `/${ACC}/wallets/${WID}/addresses`,
    payload: { address: "0xabc", type: "evm", chains: [] },
  });

describe("POST wallets/:wid/addresses → refresh enqueue", () => {
  it("ставит recurring + немедленный refresh с accountId из пути", async () => {
    const refresh = makeRefresh();
    app = await build(refresh);
    const res = await addAddress(app);
    expect(res.statusCode).toBe(201);
    expect(refresh.scheduleRecurring).toHaveBeenCalledWith(ACC, {
      everyMs: 1000,
      jitterMs: 0,
    });
    expect(refresh.enqueueManual).toHaveBeenCalledWith(ACC, "user-1", "user");
  });

  it("без refresh-зависимости адрес всё равно добавляется (опционально)", async () => {
    app = await build();
    const res = await addAddress(app);
    expect(res.statusCode).toBe(201);
  });

  it("fail-soft: сбой постановки в очередь не валит ответ 201", async () => {
    const refresh = makeRefresh();
    refresh.enqueueManual.mockRejectedValueOnce(new Error("redis down"));
    app = await build(refresh);
    const res = await addAddress(app);
    expect(res.statusCode).toBe(201);
  });
});
