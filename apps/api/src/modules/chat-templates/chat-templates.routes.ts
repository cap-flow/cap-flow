/**
 * Admin chat — quick-reply templates CRUD.
 *
 *   GET    /v1/admin/telegram-chat/templates
 *   POST   /v1/admin/telegram-chat/templates           { title, body, sortOrder? }
 *   PATCH  /v1/admin/telegram-chat/templates/:id       { title?, body?, sortOrder? }
 *   DELETE /v1/admin/telegram-chat/templates/:id
 *
 * Общий пул на всех админов — любой может редактировать. Audit
 * (кто создал) хранится в created_by, но любой админ может править.
 */

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { NotFoundError, UnauthorizedError } from "../../core/errors.js";

import type { ChatTemplatesRepository } from "./chat-templates.repository.js";

const templateSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  body: z.string(),
  sortOrder: z.number(),
  createdBy: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const createBodySchema = z.object({
  title: z.string().min(1).max(80),
  body: z.string().min(1).max(4096),
  sortOrder: z.number().int().optional(),
});

const updateBodySchema = z
  .object({
    title: z.string().min(1).max(80).optional(),
    body: z.string().min(1).max(4096).optional(),
    sortOrder: z.number().int().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field must be provided",
  });

interface RouteOpts {
  readonly repo: ChatTemplatesRepository;
}

export async function chatTemplatesRoutes(
  app: FastifyInstance,
  opts: RouteOpts,
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();
  route.addHook("preHandler", app.requireAdmin);

  route.get(
    "/",
    { schema: { response: { 200: z.array(templateSchema) } } },
    async () => {
      const rows = await opts.repo.list();
      return rows.map(serialize);
    },
  );

  route.post(
    "/",
    {
      schema: {
        body: createBodySchema,
        response: { 200: templateSchema },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const row = await opts.repo.create({
        title: req.body.title.trim(),
        body: req.body.body,
        ...(req.body.sortOrder !== undefined
          ? { sortOrder: req.body.sortOrder }
          : {}),
        createdBy: u.id,
      });
      return serialize(row);
    },
  );

  route.patch(
    "/:id",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: updateBodySchema,
        response: { 200: templateSchema },
      },
    },
    async (req) => {
      const row = await opts.repo.update(req.params.id, {
        ...(req.body.title !== undefined
          ? { title: req.body.title.trim() }
          : {}),
        ...(req.body.body !== undefined ? { body: req.body.body } : {}),
        ...(req.body.sortOrder !== undefined
          ? { sortOrder: req.body.sortOrder }
          : {}),
      });
      if (!row) throw new NotFoundError("Template not found");
      return serialize(row);
    },
  );

  route.delete(
    "/:id",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: z.object({ deleted: z.boolean() }) },
      },
    },
    async (req) => {
      const deleted = await opts.repo.delete(req.params.id);
      if (!deleted) throw new NotFoundError("Template not found");
      return { deleted };
    },
  );
}

function serialize(
  row: Awaited<ReturnType<ChatTemplatesRepository["list"]>>[number],
): {
  id: string;
  title: string;
  body: string;
  sortOrder: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    sortOrder: row.sortOrder,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
