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

    request.log.error({ err: error }, "unhandled error");

    return reply.status(500).send({
      error: "InternalServerError",
      message: "Something went wrong.",
    });
  });
}, { name: "error-handler" });
