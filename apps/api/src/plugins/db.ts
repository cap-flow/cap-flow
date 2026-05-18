import { createDbClient, type Database } from "@cap-flow/db";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
  }
}

export interface DbPluginOptions {
  readonly connectionString: string;
  readonly poolMax?: number;
  readonly poolIdleMs?: number;
}

export const dbPlugin = fp<DbPluginOptions>(
  async (app: FastifyInstance, opts) => {
    // M8: explicit pool sizing — was hard-coded to 10 inside createDbClient,
    // saturating under modest concurrency.
    const client = createDbClient({
      connectionString: opts.connectionString,
      ...(opts.poolMax !== undefined ? { max: opts.poolMax } : {}),
      ...(opts.poolIdleMs !== undefined
        ? { idleTimeoutMillis: opts.poolIdleMs }
        : {}),
    });

    app.decorate("db", client.db);
    app.addHook("onClose", async () => {
      await client.close();
    });
  },
  { name: "db" }
);
