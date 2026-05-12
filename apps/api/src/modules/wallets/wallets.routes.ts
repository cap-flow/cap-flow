import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { UnauthorizedError } from "../../core/errors.js";

import type {
  WalletAddressRow,
  WalletRow,
} from "./wallets.repository.js";
import type { WalletsService } from "./wallets.service.js";

const accountIdParam = z.object({ id: z.string().uuid() });
const walletIdParam = z.object({
  id: z.string().uuid(),
  wid: z.string().uuid(),
});
const walletAddressIdParam = z.object({
  id: z.string().uuid(),
  wid: z.string().uuid(),
  aid: z.string().uuid(),
});

const walletKindEnum = z.enum(["internal", "external"]);
const addressTypeEnum = z.enum(["evm", "solana", "tron", "btc", "other"]);

const createWalletBody = z.object({
  name: z.string().min(1).max(120),
  kind: walletKindEnum.optional(),
});

const renameWalletBody = z.object({
  name: z.string().min(1).max(120),
});

const addAddressBody = z.object({
  address: z.string().min(1).max(120),
  type: addressTypeEnum,
  chains: z.array(z.number().int().positive()).default([]),
});

const walletResponse = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  name: z.string(),
  kind: walletKindEnum,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const addressResponse = z.object({
  id: z.string().uuid(),
  walletId: z.string().uuid(),
  address: z.string(),
  type: addressTypeEnum,
  chains: z.array(z.number()),
  createdAt: z.string().datetime(),
});

interface WalletsRoutesOptions {
  readonly service: WalletsService;
}

export async function walletsRoutes(
  app: FastifyInstance,
  opts: WalletsRoutesOptions
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAuth);

  // ─── wallets ──────────────────────────────────────────────────────

  route.get(
    "/:id/wallets",
    {
      schema: {
        params: accountIdParam,
        response: { 200: z.array(walletResponse) },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const rows = await opts.service.list(req.params.id, u);
      return rows.map(toWalletResponse);
    }
  );

  route.post(
    "/:id/wallets",
    {
      schema: {
        params: accountIdParam,
        body: createWalletBody,
        response: { 201: walletResponse },
      },
    },
    async (req, reply) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const row = await opts.service.create(
        {
          accountId: req.params.id,
          name: req.body.name,
          ...(req.body.kind ? { kind: req.body.kind } : {}),
        },
        u
      );
      return reply.status(201).send(toWalletResponse(row));
    }
  );

  route.patch(
    "/:id/wallets/:wid",
    {
      schema: {
        params: walletIdParam,
        body: renameWalletBody,
        response: { 200: walletResponse },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const row = await opts.service.rename(req.params.wid, req.body.name, u);
      return toWalletResponse(row);
    }
  );

  route.delete(
    "/:id/wallets/:wid",
    { schema: { params: walletIdParam } },
    async (req, reply) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      await opts.service.delete(req.params.wid, u);
      return reply.status(204).send();
    }
  );

  // ─── addresses ────────────────────────────────────────────────────

  route.get(
    "/:id/wallets/:wid/addresses",
    {
      schema: {
        params: walletIdParam,
        response: { 200: z.array(addressResponse) },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const rows = await opts.service.listAddresses(req.params.wid, u);
      return rows.map(toAddressResponse);
    }
  );

  route.post(
    "/:id/wallets/:wid/addresses",
    {
      schema: {
        params: walletIdParam,
        body: addAddressBody,
        response: { 201: addressResponse },
      },
    },
    async (req, reply) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const row = await opts.service.addAddress(
        {
          walletId: req.params.wid,
          address: req.body.address,
          type: req.body.type,
          chains: req.body.chains,
        },
        u
      );
      return reply.status(201).send(toAddressResponse(row));
    }
  );

  route.delete(
    "/:id/wallets/:wid/addresses/:aid",
    { schema: { params: walletAddressIdParam } },
    async (req, reply) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      await opts.service.deleteAddress(req.params.aid, u);
      return reply.status(204).send();
    }
  );
}

function toWalletResponse(row: WalletRow) {
  return {
    id: row.id,
    accountId: row.accountId,
    name: row.name,
    kind: row.kind,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toAddressResponse(row: WalletAddressRow) {
  return {
    id: row.id,
    walletId: row.walletId,
    address: row.address,
    type: row.type,
    chains: row.chains,
    createdAt: row.createdAt.toISOString(),
  };
}
