import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";

import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "../core/errors.js";

export const errorHandlerPlugin = fp(async (app: FastifyInstance) => {
  app.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.status(400).send({
        error: "ValidationError",
        message: "Request validation failed.",
        issues: error.validation,
      });
    }

    if (error instanceof ValidationError) {
      return reply.status(400).send({
        error: "ValidationError",
        message: error.message,
        issues: error.issues,
      });
    }

    if (error instanceof UnauthorizedError) {
      return reply.status(401).send({
        error: "UnauthorizedError",
        message: error.message,
      });
    }

    if (error instanceof ForbiddenError) {
      return reply.status(403).send({
        error: "ForbiddenError",
        message: error.message,
      });
    }

    if (error instanceof NotFoundError) {
      return reply.status(404).send({
        error: "NotFoundError",
        message: error.message,
      });
    }

    if (error instanceof ConflictError) {
      return reply.status(409).send({
        error: "ConflictError",
        message: error.message,
      });
    }

    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: error.name,
        message: error.message,
      });
    }

    // Honor `error.statusCode` set by middleware/plugins (e.g.
    // @fastify/rate-limit throws a plain Error with statusCode=429 and
    // a "Rate limit exceeded, retry in N minutes" message). Pre-fix
    // these surfaced as 500 because they're not instanceof AppError —
    // the user got "Something went wrong" instead of the actual
    // rate-limit explanation.
    const code =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? ((error as { statusCode: number }).statusCode)
        : 0;
    if (code >= 400 && code < 600) {
      const e = error as { code?: string; name?: string; message?: string };
      return reply.status(code).send({
        error: e.code ?? e.name ?? "Error",
        message: e.message ?? "Request failed.",
      });
    }

    request.log.error({ err: error }, "unhandled error");

    // Diagnostic side-channel: write the last unhandled error to a
    // file so developers can read it without scraping stdout of the
    // tsx watch process. The file is overwritten on every 500 — we
    // only ever care about the most recent one. Best-effort: any IO
    // failure is swallowed, response semantics are unchanged.
    try {
      const err = error as Error;
      const payload = [
        `[${new Date().toISOString()}] ${request.method} ${request.url}`,
        `name: ${err.name}`,
        `message: ${err.message}`,
        `stack: ${err.stack ?? "(no stack)"}`,
      ].join("\n");
      // process.cwd() for the API process is apps/api when started
      // via `pnpm --filter @cap-flow/api dev`.
      writeFileSync(join(process.cwd(), "tmp", "last-500.log"), payload + "\n", {
        flag: "w",
      });
    } catch {
      /* file logging is best-effort */
    }

    return reply.status(500).send({
      error: "InternalServerError",
      message: "Something went wrong.",
    });
  });
}, { name: "error-handler" });
